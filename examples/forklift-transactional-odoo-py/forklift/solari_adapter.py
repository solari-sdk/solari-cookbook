"""Narrow Solari adapter for immutable desktop branches.

The published Python ``DesktopClient`` in 0.2.0 does not expose the
``from_snapshot`` create option.  The unified ``SandboxClient`` does, including
for ``kind="desktop"``.  This adapter uses that public create call and restores
the computer-use ``Desktop`` handle that the generic client intentionally
narrows to ``Sandbox``.

All private SDK access is isolated here.  The wire behavior is covered by the
official ``POST /sandboxes`` contract and can be replaced without touching the
promotion policy.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote, urlsplit, urlunsplit

from solari_core import CreateDesktopResponse, Desktop, DesktopConfig
from solari_sandbox import SandboxClient


@dataclass(frozen=True)
class SnapshotRecord:
    snapshot_id: str
    parent_id: str | None
    kind: str
    template: str


def stream_url_from_control_url(control_url: str) -> str:
    """Derive the sibling RFB route without decoding the signed session id."""

    parsed = urlsplit(control_url)
    marker = "/control/"
    if marker not in parsed.path:
        raise ValueError("Solari control URL does not contain /control/")
    stream_path = parsed.path.replace(marker, "/stream/", 1)
    return urlunsplit((parsed.scheme, parsed.netloc, stream_path, parsed.query, parsed.fragment))


class SolariDesktopBranches:
    """Create GUI branches from snapshots and promote only sealed snapshots."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://api.getsolari.com",
        call_timeout_ms: int = 300_000,
    ) -> None:
        self._api_key = api_key
        self._call_timeout_ms = call_timeout_ms
        self._client = SandboxClient(
            api_key=api_key,
            base_url=base_url,
            call_timeout_ms=call_timeout_ms,
            kind="desktop",
        )

    async def __aenter__(self) -> "SolariDesktopBranches":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self._client.aclose()

    def _as_desktop(self, generic: object) -> Desktop:
        """Restore the full GUI handle erased by ``SandboxClient`` typing."""

        session = CreateDesktopResponse(
            sessionId=generic.id,
            controlUrl=generic.controlUrl,
            streamUrl=stream_url_from_control_url(generic.controlUrl),
            expiresAt=generic.expiresAt,
        )
        config = DesktopConfig(
            callTimeoutMs=self._call_timeout_ms,
            headers={"Authorization": f"Bearer {self._api_key}"},
            # SandboxClient and DesktopClient use the same unified lifecycle
            # routes.  Reusing these hooks preserves snapshot/revert/kill.
            hooks=generic._hooks,
        )
        return Desktop(session, config)

    async def create_golden(
        self,
        *,
        metadata: dict[str, str],
        template: str = "default",
        cpu: int = 4,
        mem_mb: int = 8192,
        disk_gb: int | None = None,
        timeout_ms: int = 30 * 60 * 1000,
    ) -> Desktop:
        """Create the only mutable golden-boot desktop in a new lineage.

        Snapshot-derived workers must use :meth:`fork`.  Keeping this separate
        makes it difficult to accidentally treat an unsealed fresh VM as a
        candidate branch.
        """

        generic = await self._client.create(
            template=template,
            cpu=cpu,
            mem_mb=mem_mb,
            disk_gb=disk_gb,
            metadata=metadata,
            timeout_ms=timeout_ms,
            lifecycle={"onTimeout": "pause", "autoResume": False},
        )
        return self._as_desktop(generic)

    async def fork(
        self,
        *,
        snapshot_id: str,
        metadata: dict[str, str],
        cpu: int = 4,
        mem_mb: int = 8192,
        timeout_ms: int = 15 * 60 * 1000,
    ) -> Desktop:
        """Create an independent GUI VM whose parent is ``snapshot_id``."""

        generic = await self._client.create(
            from_snapshot=snapshot_id,
            cpu=cpu,
            mem_mb=mem_mb,
            metadata=metadata,
            timeout_ms=timeout_ms,
            lifecycle={"onTimeout": "pause", "autoResume": False},
        )
        return self._as_desktop(generic)

    async def get_snapshot(self, snapshot_id: str) -> SnapshotRecord:
        data = await self._client._request("GET", f"/snapshots/{quote(snapshot_id, safe='')}")
        return SnapshotRecord(
            snapshot_id=data["id"],
            parent_id=data.get("parent"),
            kind=data["kind"],
            template=data["template"],
        )

    async def promote_snapshot(self, snapshot_id: str, *, name: str) -> str:
        """Register an already-oracle-approved snapshot as a durable template."""

        if not name.strip():
            raise ValueError("promotion template name cannot be blank")
        data = await self._client._request(
            "POST",
            f"/snapshots/{quote(snapshot_id, safe='')}/promote",
            {"name": name},
        )
        return data["templateId"]

    async def delete_snapshot(self, snapshot_id: str) -> None:
        await self._client.delete_snapshot(snapshot_id)


class SolariSandboxBranches:
    """Immutable headless branches that hold the transactional application state."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://api.getsolari.com",
        call_timeout_ms: int = 300_000,
    ) -> None:
        self._client = SandboxClient(
            api_key=api_key,
            base_url=base_url,
            call_timeout_ms=call_timeout_ms,
            kind="sandbox",
        )

    async def __aenter__(self) -> "SolariSandboxBranches":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self._client.aclose()

    async def create_golden(
        self,
        *,
        metadata: dict[str, str],
        template: str = "base",
        cpu: int = 4,
        mem_mb: int = 8192,
        disk_gb: int = 100,
        timeout_ms: int = 30 * 60 * 1000,
    ):
        return await self._client.create(
            template=template,
            cpu=cpu,
            mem_mb=mem_mb,
            disk_gb=disk_gb,
            metadata=metadata,
            timeout_ms=timeout_ms,
            lifecycle={"onTimeout": "pause", "autoResume": False},
        )

    async def fork(
        self,
        *,
        snapshot_id: str,
        metadata: dict[str, str],
        cpu: int = 4,
        mem_mb: int = 8192,
        timeout_ms: int = 15 * 60 * 1000,
    ):
        return await self._client.create(
            from_snapshot=snapshot_id,
            cpu=cpu,
            mem_mb=mem_mb,
            metadata=metadata,
            timeout_ms=timeout_ms,
            lifecycle={"onTimeout": "pause", "autoResume": False},
        )

    async def get_snapshot(self, snapshot_id: str) -> SnapshotRecord:
        data = await self._client._request("GET", f"/snapshots/{quote(snapshot_id, safe='')}")
        return SnapshotRecord(
            snapshot_id=data["id"],
            parent_id=data.get("parent"),
            kind=data["kind"],
            template=data["template"],
        )

    async def promote_snapshot(self, snapshot_id: str, *, name: str) -> str:
        if not name.strip():
            raise ValueError("promotion template name cannot be blank")
        data = await self._client._request(
            "POST",
            f"/snapshots/{quote(snapshot_id, safe='')}/promote",
            {"name": name},
        )
        return data["templateId"]

    async def delete_snapshot(self, snapshot_id: str) -> None:
        await self._client.delete_snapshot(snapshot_id)
