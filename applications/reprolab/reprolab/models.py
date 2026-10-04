"""Versioned inputs and structured evidence for the single ReproLab V1 recipe."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

SUPPORTED_SCHEMA = "1.0"
SUPPORTED_RECIPE = "csv_identifier_libreoffice"
CELL_RE = re.compile(r"^[A-Z]{1,3}[1-9][0-9]*$")


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def redact_identifier(value: str | None) -> str | None:
    if value is None or len(value) <= 18:
        return value
    return f"{value[:8]}…{value[-6:]}"


def redact_url(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme == "data":
        return "data:[redacted fixture]"
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, host, parts.path, "", ""))


@dataclass(frozen=True)
class PageAssertion:
    title: str
    contains_text: str

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> PageAssertion:
        return cls(
            title=str(value.get("title", "")), contains_text=str(value.get("contains_text", ""))
        )


@dataclass(frozen=True)
class RunSpec:
    schema_version: str
    recipe: str
    target_url: str
    profile_id: str | None
    page_assertion: PageAssertion
    row_selector: dict[str, str]
    target_column: str
    target_cell: str
    expected_text: str
    known_failure_text: str

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> RunSpec:
        required = (
            "schema_version",
            "recipe",
            "target_url",
            "page_assertion",
            "row_selector",
            "target_column",
            "target_cell",
            "expected_text",
            "known_failure_text",
        )
        missing = [name for name in required if name not in value]
        if missing:
            raise ValueError(f"missing required RunSpec fields: {', '.join(missing)}")
        spec = cls(
            schema_version=str(value["schema_version"]),
            recipe=str(value["recipe"]),
            target_url=str(value["target_url"]),
            profile_id=str(value["profile_id"]) if value.get("profile_id") else None,
            page_assertion=PageAssertion.from_dict(dict(value["page_assertion"])),
            row_selector={str(k): str(v) for k, v in dict(value["row_selector"]).items()},
            target_column=str(value["target_column"]),
            target_cell=str(value["target_cell"]),
            expected_text=str(value["expected_text"]),
            known_failure_text=str(value["known_failure_text"]),
        )
        spec.validate()
        return spec

    def validate(self) -> None:
        if self.schema_version != SUPPORTED_SCHEMA:
            raise ValueError(f"unsupported schema_version: {self.schema_version}")
        if self.recipe != SUPPORTED_RECIPE:
            raise ValueError(f"unsupported recipe: {self.recipe}")
        scheme = urlsplit(self.target_url).scheme
        if scheme not in {"https", "http", "data"}:
            raise ValueError("target_url must use https, http, or the built-in data fixture")
        if not self.page_assertion.title or not self.page_assertion.contains_text:
            raise ValueError("page_assertion.title and contains_text are required")
        if not self.row_selector or any(
            not key or not val for key, val in self.row_selector.items()
        ):
            raise ValueError("a non-empty row_selector assertion is required")
        if not self.target_column:
            raise ValueError("target_column is required")
        if not CELL_RE.fullmatch(self.target_cell):
            raise ValueError("target_cell must be an A1-style cell such as A2")
        if not self.expected_text:
            raise ValueError("expected_text is required")
        if not self.known_failure_text:
            raise ValueError("known_failure_text is required")
        if self.expected_text == self.known_failure_text:
            raise ValueError("known_failure_text must differ from expected_text")

    def to_evidence_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["target_url"] = redact_url(self.target_url)
        value["profile_id"] = redact_identifier(self.profile_id)
        return value


@dataclass(frozen=True)
class ArtifactRecord:
    artifact_id: str
    filename: str
    byte_length: int
    sha256: str
    controller_path: Path
    created_at: str
    content: bytes = field(repr=False)

    @classmethod
    def create(cls, filename: str, path: Path, content: bytes, sha256: str) -> ArtifactRecord:
        return cls(
            artifact_id=f"artifact_{uuid4().hex[:12]}",
            filename=filename,
            byte_length=len(content),
            sha256=sha256,
            controller_path=path,
            created_at=utc_now(),
            content=content,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "filename": self.filename,
            "byte_length": self.byte_length,
            "sha256": self.sha256,
            "controller_path": str(self.controller_path),
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class BrowserResult:
    correct_page: bool
    download_completed: bool
    http_status: int | None
    title: str
    matched_text: str
    filename: str | None
    mime_type: str | None
    byte_length: int | None
    sha256: str | None
    timestamp: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SandboxAnalysis:
    hash: str
    hash_matches: bool
    schema_valid: bool
    row_found: bool
    raw_value: str | None
    expected_value: str
    raw_matches_expected: bool
    environment: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class DesktopObservation:
    artifact_hash: str
    hash_matches: bool
    libreoffice_version: str
    active_window_verified: bool
    target_cell: str
    selection_verified: bool
    clipboard_sentinel_changed: bool
    solari_clipboard_value: str | None
    x11_available: bool
    x11_clipboard_value: str | None
    observations_agree: bool
    screenshot: str | None
    environment: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CleanupRecord:
    resource_type: str
    resource_id: str
    created: bool = True
    cleanup_attempted: bool = False
    cleanup_succeeded: bool = False
    cleanup_error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class VerdictStatus(str, Enum):
    CONFIRMED = "CONFIRMED"
    NOT_REPRODUCED = "NOT_REPRODUCED"
    INCONCLUSIVE = "INCONCLUSIVE"


@dataclass(frozen=True)
class Verdict:
    status: VerdictStatus
    reason: str
    gates: dict[str, bool]
    raw_value: str | None
    desktop_value: str | None

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["status"] = self.status.value
        return value


class RunStage(str, Enum):
    CREATED = "CREATED"
    VALIDATED = "VALIDATED"
    BROWSER_RUNNING = "BROWSER_RUNNING"
    ARTIFACT_CAPTURED = "ARTIFACT_CAPTURED"
    SANDBOX_VERIFIED = "SANDBOX_VERIFIED"
    DESKTOP_RUNNING = "DESKTOP_RUNNING"
    DESKTOP_OBSERVED = "DESKTOP_OBSERVED"
    VERDICT_COMPLETE = "VERDICT_COMPLETE"
    EVIDENCE_COMPLETE = "EVIDENCE_COMPLETE"
    CLEANUP_COMPLETE = "CLEANUP_COMPLETE"


class StageStatus(str, Enum):
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"


@dataclass(frozen=True)
class StageRecord:
    stage: RunStage
    status: StageStatus
    timestamp: str
    output: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["stage"] = self.stage.value
        value["status"] = self.status.value
        return value


@dataclass
class RunState:
    run_id: str = field(default_factory=lambda: f"rr_{uuid4().hex[:12]}")
    stages: list[StageRecord] = field(default_factory=list)

    def record(
        self,
        stage: RunStage,
        status: StageStatus,
        *,
        output: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        self.stages.append(
            StageRecord(
                stage=stage,
                status=status,
                timestamp=utc_now(),
                output=output or {},
                error=error,
            )
        )

    def to_dict(self) -> dict[str, Any]:
        return {"run_id": self.run_id, "stages": [stage.to_dict() for stage in self.stages]}
