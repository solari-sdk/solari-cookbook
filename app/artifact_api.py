from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from app.artifact_catalog import (
    artifact_metadata,
    artifact_preview,
    build_evidence_bundle,
    cleanup_expired_artifacts,
    link_artifact,
    list_artifacts,
    load_cataloged_artifact,
    set_artifact_retention,
    tag_artifact,
)

router = APIRouter(prefix="/api/v1", tags=["artifacts"])


class TagInput(BaseModel):
    tag: str = Field(min_length=1, max_length=100)


class ArtifactLinkInput(BaseModel):
    object_type: str = Field(min_length=1, max_length=40)
    object_id: str = Field(min_length=1, max_length=256)
    relation: str = Field(default="evidence", min_length=1, max_length=120)


class RetentionInput(BaseModel):
    retention_days: int | None = Field(default=None, ge=0, le=36500)


class BundleInput(BaseModel):
    sha256: list[str] = Field(min_length=1, max_length=1000)


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, KeyError): return HTTPException(404, str(exc).strip("'"))
    if isinstance(exc, ValueError): return HTTPException(400, str(exc))
    return HTTPException(500, type(exc).__name__)


@router.get("/artifacts")
def artifacts(limit: int = Query(500, ge=1, le=1000), tag: str | None = None, object_type: str | None = None, object_id: str | None = None) -> list[dict[str, object]]:
    return list_artifacts(limit, tag=tag, object_type=object_type, object_id=object_id)


@router.get("/artifacts/{sha256_digest}/metadata")
def metadata(sha256_digest: str) -> dict[str, object]:
    try: return artifact_metadata(sha256_digest)
    except Exception as exc: raise _error(exc) from exc


@router.get("/artifacts/{sha256_digest}/preview")
def preview(sha256_digest: str) -> dict[str, object]:
    try: return artifact_preview(sha256_digest)
    except Exception as exc: raise _error(exc) from exc


@router.get("/artifacts/{sha256_digest}")
def raw_artifact(sha256_digest: str) -> Response:
    try:
        record, data = load_cataloged_artifact(sha256_digest)
    except Exception as exc:
        raise _error(exc) from exc
    headers = {"X-Content-SHA256": record.sha256, "Cache-Control": "private, no-store"}
    if record.original_name:
        safe_name = record.original_name.replace('"', "").replace("\r", "").replace("\n", "")
        headers["Content-Disposition"] = f'attachment; filename="{safe_name}"'
    return Response(content=data, media_type=record.mime_type, headers=headers)


@router.post("/artifacts/{sha256_digest}/tags")
def add_tag(sha256_digest: str, body: TagInput) -> dict[str, object]:
    try: return tag_artifact(sha256_digest, body.tag)
    except Exception as exc: raise _error(exc) from exc


@router.post("/artifacts/{sha256_digest}/links")
def add_link(sha256_digest: str, body: ArtifactLinkInput) -> dict[str, object]:
    try: return link_artifact(sha256_digest, body.object_type, body.object_id, relation=body.relation)
    except Exception as exc: raise _error(exc) from exc


@router.put("/artifacts/{sha256_digest}/retention")
def retention(sha256_digest: str, body: RetentionInput) -> dict[str, object]:
    try: return set_artifact_retention(sha256_digest, retention_days=body.retention_days)
    except Exception as exc: raise _error(exc) from exc


@router.post("/artifacts/cleanup-expired")
def cleanup(dry_run: bool = True) -> dict[str, object]:
    try: return cleanup_expired_artifacts(dry_run=dry_run)
    except Exception as exc: raise _error(exc) from exc


@router.post("/artifacts/evidence-bundle")
def evidence_bundle(body: BundleInput) -> Response:
    try: data = build_evidence_bundle(body.sha256)
    except Exception as exc: raise _error(exc) from exc
    return Response(content=data, media_type="application/zip", headers={"Content-Disposition": "attachment; filename=solari-evidence-bundle.zip", "Cache-Control": "private, no-store"})
