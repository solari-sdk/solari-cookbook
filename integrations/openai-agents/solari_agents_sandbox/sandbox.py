"""Solari sandbox provider for the OpenAI Agents SDK.

Implements the SDK's ``BaseSandboxClient`` / ``BaseSandboxSession`` contract on
top of Solari's ``solari-sandbox`` Python SDK, so an ``agents.sandbox.SandboxAgent``
can run model-directed work inside a Solari Cloud-Hypervisor microVM:

    from agents import Runner
    from agents.run import RunConfig
    from agents.sandbox import SandboxAgent, SandboxRunConfig
    from solari_agents_sandbox import SolariSandboxClient, SolariSandboxClientOptions

    client = SolariSandboxClient()  # reads SOLARI_API_KEY
    result = await Runner.run(
        agent,
        "Fix the failing test in repo/ and show the command you ran.",
        run_config=RunConfig(
            sandbox=SandboxRunConfig(
                client=client,
                options=SolariSandboxClientOptions(pause_on_exit=True),
            ),
        ),
    )

Design notes
------------
* ``create`` provisions a warm Solari microVM (~0.8s restore) and opens its
  control channel. ``delete`` pauses (when ``pause_on_exit``) or kills it.
* ``resume`` reattaches to the *same* backend microVM by id — Solari keeps it
  paused-warm with cross-host S3 recovery, which is exactly the "reattach, or
  hydrate a replacement from ``state.snapshot``" contract the SDK asks for.
* Workspace persistence uses the SDK's tar convention (``persist_workspace`` /
  ``hydrate_workspace``) over Solari's ``exec`` + ``files`` RPCs.

The Solari SDK import is lazy (see ``_import_solari_sdk``) so this module can be
imported for type-checking / registration without ``solari-sandbox`` installed.
"""

from __future__ import annotations

import io
import math
import os
import shlex
import uuid
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from agents.sandbox.errors import (
    ExposedPortUnavailableError,
    WorkspaceArchiveReadError,
    WorkspaceArchiveWriteError,
    WorkspaceReadNotFoundError,
    WorkspaceWriteTypeError,
)
from agents.sandbox.manifest import Manifest
from agents.sandbox.session import SandboxSession, SandboxSessionState
from agents.sandbox.session.base_sandbox_session import BaseSandboxSession
from agents.sandbox.session.dependencies import Dependencies
from agents.sandbox.session.manager import Instrumentation
from agents.sandbox.session.sandbox_client import BaseSandboxClient
from agents.sandbox.session.tar_workspace import shell_tar_exclude_args
from agents.sandbox.snapshot import SnapshotBase, SnapshotSpec, resolve_snapshot
from agents.sandbox.types import ExecResult, ExposedPortEndpoint, User
from agents.sandbox.util.tar_utils import UnsafeTarMemberError, validate_tar_bytes
from agents.sandbox.workspace_paths import coerce_posix_path, posix_path_as_path, sandbox_path_str

DEFAULT_SOLARI_BASE_URL = "https://api.getsolari.com"
DEFAULT_SOLARI_WORKSPACE_ROOT = "/workspace"


def _import_solari_sdk() -> Any:
    """Import ``solari_sandbox`` lazily with a helpful error if it's missing."""
    try:
        import solari_sandbox  # type: ignore
    except ImportError as e:  # pragma: no cover - import guard
        raise ImportError(
            "The Solari sandbox provider requires the `solari-sandbox` package. "
            "Install it with `pip install openai-agents[solari]` or `pip install solari-sandbox`."
        ) from e
    return solari_sandbox


# ---------------------------------------------------------------------------
# Options + serializable state
# ---------------------------------------------------------------------------


class SolariTimeouts(BaseModel):
    model_config = {"frozen": True}

    exec_timeout_s: float = Field(default=300.0, ge=1)
    cleanup_s: float = Field(default=30.0, ge=1)
    workspace_tar_s: float = Field(default=300.0, ge=1)


class SolariSandboxClientOptions(BaseModel):
    """Client options for a Solari-backed sandbox session."""

    model_config = {"frozen": True, "arbitrary_types_allowed": True}

    type: Literal["solari"] = "solari"
    template: str | None = None
    cpu: int | None = None
    mem_mb: int | None = None
    disk_gb: int | None = None
    env_vars: dict[str, str] = Field(default_factory=dict)
    metadata: dict[str, str] = Field(default_factory=dict)
    # When true, `delete()` pauses the microVM (kept warm for a later `resume`)
    # instead of killing it, and Solari's idle policy auto-resumes on reconnect.
    pause_on_exit: bool = False
    base_url: str | None = None
    timeouts: SolariTimeouts = Field(default_factory=SolariTimeouts)


class SolariSandboxSessionState(SandboxSessionState):
    """Serializable state for a Solari-backed session (JSON round-trips)."""

    type: Literal["solari"] = "solari"
    sandbox_id: str
    base_url: str = DEFAULT_SOLARI_BASE_URL
    template: str | None = None
    cpu: int | None = None
    mem_mb: int | None = None
    disk_gb: int | None = None
    base_env_vars: dict[str, str] = Field(default_factory=dict)
    metadata: dict[str, str] = Field(default_factory=dict)
    pause_on_exit: bool = False
    timeouts: SolariTimeouts = Field(default_factory=SolariTimeouts)


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------


class SolariSandboxSession(BaseSandboxSession):
    """Solari-backed sandbox session implementation."""

    state: SolariSandboxSessionState
    _sandbox: Any  # solari_sandbox Sandbox handle
    _solari_client: Any  # solari_sandbox.SandboxClient (for reconnect/kill)
    _skip_start: bool

    def __init__(
        self,
        *,
        state: SolariSandboxSessionState,
        sandbox: Any,
        solari_client: Any,
    ) -> None:
        self.state = state
        self._sandbox = sandbox
        self._solari_client = solari_client
        self._skip_start = False

    @classmethod
    def from_state(
        cls,
        state: SolariSandboxSessionState,
        *,
        sandbox: Any,
        solari_client: Any,
    ) -> "SolariSandboxSession":
        return cls(state=state, sandbox=sandbox, solari_client=solari_client)

    def supports_pty(self) -> bool:
        return False

    # -- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        # On a warm reattach we keep the existing workspace and skip re-applying
        # the manifest over files that may have changed while paused.
        if self._skip_start:
            return
        root = sandbox_path_str(self.state.manifest.root)
        # Solari base images run as root and don't pre-create the workspace root.
        try:
            await self._sandbox.commands.run(
                "sh", args=["-lc", f"mkdir -p {shlex.quote(root)}"], timeout_ms=10_000
            )
        except Exception:
            pass  # best-effort; manifest materialization will surface real failures
        await super().start()

    async def stop(self) -> None:
        await super().stop()

    async def shutdown(self) -> None:
        # Control-channel teardown; the client decides pause-vs-kill in delete().
        try:
            await self._sandbox.close()
        except Exception:
            pass

    async def running(self) -> bool:
        try:
            res = await self._sandbox.commands.run("true", timeout_ms=10_000)
            return int(getattr(res, "exitCode", 1)) == 0
        except Exception:
            return False

    # -- exec ----------------------------------------------------------------

    def _coerce_exec_timeout(self, timeout_s: float | None) -> float:
        if timeout_s is None:
            return float(self.state.timeouts.exec_timeout_s)
        return 0.001 if timeout_s <= 0 else float(timeout_s)

    async def _exec_internal(
        self,
        *command: str | Path,
        timeout: float | None = None,
    ) -> ExecResult:
        # `command` already carries any shell prefix from BaseSandboxSession.exec
        # (e.g. ("sh", "-lc", "<joined>")). Map the head to the program and the
        # rest to args for Solari's cmd.run RPC.
        parts = [str(c) for c in command]
        prog, args = parts[0], parts[1:]
        exec_timeout = self._coerce_exec_timeout(timeout)
        timeout_ms = int(max(1, math.ceil(exec_timeout)) * 1000)
        cwd = sandbox_path_str(self.state.manifest.root)
        envs = {**self.state.base_env_vars}

        res = await self._sandbox.commands.run(
            prog,
            args=args,
            cwd=cwd,
            env=envs or None,
            timeout_ms=timeout_ms,
        )
        exit_code = int(getattr(res, "exitCode", 0) or 0)
        stdout = str(getattr(res, "stdout", "") or "").encode("utf-8", errors="replace")
        stderr = str(getattr(res, "stderr", "") or "").encode("utf-8", errors="replace")
        return ExecResult(stdout=stdout, stderr=stderr, exit_code=exit_code)

    # -- files ---------------------------------------------------------------

    async def read(self, path: Path | str, *, user: str | User | None = None) -> io.IOBase:
        error_path = posix_path_as_path(coerce_posix_path(path))
        workspace_path = await self._validate_path_access(path)
        try:
            data = await self._sandbox.files.read(sandbox_path_str(workspace_path))
            if isinstance(data, str):
                data = data.encode("utf-8")
            return io.BytesIO(bytes(data))
        except Exception as e:
            msg = str(e).lower()
            if "not found" in msg or "no such file" in msg or getattr(e, "status", None) == 404:
                raise WorkspaceReadNotFoundError(path=error_path, cause=e) from e
            raise WorkspaceArchiveReadError(path=error_path, cause=e) from e

    async def write(
        self,
        path: Path | str,
        data: io.IOBase,
        *,
        user: str | User | None = None,
    ) -> None:
        error_path = posix_path_as_path(coerce_posix_path(path))
        payload = data.read()
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        if not isinstance(payload, (bytes, bytearray)):
            raise WorkspaceWriteTypeError(path=error_path, actual_type=type(payload).__name__)
        workspace_path = await self._validate_path_access(path, for_write=True)
        try:
            await self._sandbox.files.write(sandbox_path_str(workspace_path), bytes(payload))
        except Exception as e:
            raise WorkspaceArchiveWriteError(path=workspace_path, cause=e) from e

    # -- ports ---------------------------------------------------------------

    async def _resolve_exposed_port(self, port: int) -> ExposedPortEndpoint:
        try:
            preview = await self._sandbox.preview_url(port)
        except Exception as e:
            raise ExposedPortUnavailableError(
                port=port,
                exposed_ports=self.state.exposed_ports,
                reason="backend_unavailable",
                context={"backend": "solari", "detail": "preview_url_failed"},
                cause=e,
            ) from e
        url = preview.get("url") if isinstance(preview, dict) else None
        token = preview.get("token") if isinstance(preview, dict) else None
        if not isinstance(url, str) or not url:
            raise ExposedPortUnavailableError(
                port=port,
                exposed_ports=self.state.exposed_ports,
                reason="backend_unavailable",
                context={"backend": "solari", "detail": "invalid_preview_url", "url": url},
            )
        split = urlsplit(url)
        host = split.hostname
        if host is None:
            raise ExposedPortUnavailableError(
                port=port,
                exposed_ports=self.state.exposed_ports,
                reason="backend_unavailable",
                context={"backend": "solari", "detail": "url_parse_failed", "url": url},
            )
        port_value = split.port or (443 if split.scheme == "https" else 80)
        query = f"token={token}" if isinstance(token, str) and token else ""
        return ExposedPortEndpoint(
            host=host, port=port_value, tls=split.scheme == "https", query=query
        )

    # -- workspace persistence (tar convention) ------------------------------

    def _tar_exclude_args(self) -> list[str]:
        return shell_tar_exclude_args(self._persist_workspace_skip_relpaths())

    async def persist_workspace(self) -> io.IOBase:
        root = self._workspace_root_path()
        tar_path = f"/tmp/solari-persist-{self.state.session_id.hex}.tar"
        excludes = " ".join(self._tar_exclude_args())
        tar_cmd = (
            f"tar {excludes} -C {shlex.quote(root.as_posix())} -cf {shlex.quote(tar_path)} ."
        ).strip()
        try:
            result = await self._exec_internal(
                "sh", "-lc", tar_cmd, timeout=self.state.timeouts.workspace_tar_s
            )
            if result.exit_code != 0:
                raise WorkspaceArchiveReadError(
                    path=root,
                    context={
                        "reason": "tar_create_failed",
                        "output": result.stderr.decode("utf-8", errors="replace"),
                    },
                )
            data = await self._sandbox.files.read(tar_path)
            if isinstance(data, str):
                data = data.encode("utf-8")
            return io.BytesIO(bytes(data))
        except WorkspaceArchiveReadError:
            raise
        except Exception as e:
            raise WorkspaceArchiveReadError(path=root, cause=e) from e
        finally:
            try:
                await self._exec_internal(
                    "rm", "-f", "--", tar_path, timeout=self.state.timeouts.cleanup_s
                )
            except Exception:
                pass

    async def hydrate_workspace(self, data: io.IOBase) -> None:
        root = self._workspace_root_path()
        tar_path = f"/tmp/solari-hydrate-{self.state.session_id.hex}.tar"
        payload = data.read()
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        if not isinstance(payload, (bytes, bytearray)):
            raise WorkspaceWriteTypeError(path=Path(tar_path), actual_type=type(payload).__name__)
        try:
            validate_tar_bytes(bytes(payload), allow_external_symlink_targets=False)
        except UnsafeTarMemberError as e:
            raise WorkspaceArchiveWriteError(
                path=root,
                context={"reason": "unsafe_or_invalid_tar", "member": e.member, "detail": str(e)},
                cause=e,
            ) from e
        try:
            await self.mkdir(root, parents=True)
            await self._sandbox.files.write(tar_path, bytes(payload))
            result = await self._exec_internal(
                "sh",
                "-lc",
                f"tar -C {shlex.quote(root.as_posix())} -xf {shlex.quote(tar_path)}",
                timeout=self.state.timeouts.workspace_tar_s,
            )
            if result.exit_code != 0:
                raise WorkspaceArchiveWriteError(
                    path=root,
                    context={
                        "reason": "tar_extract_failed",
                        "output": result.stderr.decode("utf-8", errors="replace"),
                    },
                )
        except WorkspaceArchiveWriteError:
            raise
        except Exception as e:
            raise WorkspaceArchiveWriteError(path=root, cause=e) from e
        finally:
            try:
                await self._exec_internal(
                    "rm", "-f", "--", tar_path, timeout=self.state.timeouts.cleanup_s
                )
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class SolariSandboxClient(BaseSandboxClient["SolariSandboxClientOptions"]):
    """Solari sandbox client managing microVM lifecycle via the Solari SDK."""

    backend_id = "solari"
    supports_default_options = True

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        instrumentation: Instrumentation | None = None,
        dependencies: Dependencies | None = None,
    ) -> None:
        _import_solari_sdk()  # fail fast if the SDK is missing
        self._api_key = api_key or os.environ.get("SOLARI_API_KEY")
        self._base_url = base_url or os.environ.get("SOLARI_BASE_URL") or DEFAULT_SOLARI_BASE_URL
        self._instrumentation = instrumentation if instrumentation is not None else Instrumentation()
        self._dependencies = dependencies

    def _new_solari_client(self, base_url: str) -> Any:
        solari_sandbox = _import_solari_sdk()
        return solari_sandbox.SandboxClient(api_key=self._api_key, base_url=base_url)

    async def create(
        self,
        *,
        snapshot: SnapshotSpec | SnapshotBase | None = None,
        manifest: Manifest | None = None,
        options: SolariSandboxClientOptions,
    ) -> SandboxSession:
        if manifest is None:
            manifest = Manifest(root=DEFAULT_SOLARI_WORKSPACE_ROOT)
        self._validate_manifest_for_create(manifest)

        base_url = options.base_url or self._base_url
        solari_client = self._new_solari_client(base_url)

        lifecycle = {"onTimeout": "pause", "autoResume": True} if options.pause_on_exit else None
        sandbox = await solari_client.create(
            template=options.template,
            cpu=options.cpu,
            mem_mb=options.mem_mb,
            disk_gb=options.disk_gb,
            envs=dict(options.env_vars) or None,
            metadata=dict(options.metadata) or None,
            lifecycle=lifecycle,
        )
        await sandbox.connect()

        session_id = uuid.uuid4()
        state = SolariSandboxSessionState(
            session_id=session_id,
            manifest=manifest,
            snapshot=resolve_snapshot(snapshot, str(session_id)),
            sandbox_id=sandbox.id,
            base_url=base_url,
            template=options.template,
            cpu=options.cpu,
            mem_mb=options.mem_mb,
            disk_gb=options.disk_gb,
            base_env_vars=dict(options.env_vars),
            metadata=dict(options.metadata),
            pause_on_exit=options.pause_on_exit,
            timeouts=options.timeouts,
        )
        inner = SolariSandboxSession.from_state(
            state, sandbox=sandbox, solari_client=solari_client
        )
        return self._wrap_session(inner, instrumentation=self._instrumentation)

    async def delete(self, session: SandboxSession) -> SandboxSession:
        inner = session._inner
        if not isinstance(inner, SolariSandboxSession):
            raise TypeError("SolariSandboxClient.delete expects a SolariSandboxSession")
        try:
            if inner.state.pause_on_exit:
                await inner._sandbox.pause()
            else:
                await inner._sandbox.kill()
        except Exception:
            pass
        try:
            await inner.shutdown()
        except Exception:
            pass
        return session

    async def resume(self, state: SandboxSessionState) -> SandboxSession:
        if not isinstance(state, SolariSandboxSessionState):
            raise TypeError("SolariSandboxClient.resume expects a SolariSandboxSessionState")
        state.assert_path_grants_rebound()

        solari_client = self._new_solari_client(state.base_url)
        sandbox = None
        reconnected = False
        # Reattach to the same paused-warm microVM (Solari keeps it recoverable
        # cross-host via S3). If it's gone, fall through to a fresh VM hydrated
        # from state.snapshot during start().
        try:
            sandbox = await solari_client.connect(state.sandbox_id)
            if state.pause_on_exit:
                try:
                    await sandbox.resume()
                except Exception:
                    pass
            await sandbox.connect()
            reconnected = True
        except Exception:
            reconnected = False

        if not reconnected or sandbox is None:
            lifecycle = {"onTimeout": "pause", "autoResume": True} if state.pause_on_exit else None
            sandbox = await solari_client.create(
                template=state.template,
                cpu=state.cpu,
                mem_mb=state.mem_mb,
                disk_gb=state.disk_gb,
                envs=state.base_env_vars or None,
                metadata=state.metadata or None,
                lifecycle=lifecycle,
            )
            await sandbox.connect()
            state.sandbox_id = sandbox.id

        inner = SolariSandboxSession.from_state(
            state, sandbox=sandbox, solari_client=solari_client
        )
        if reconnected:
            inner._skip_start = True
        return self._wrap_session(inner, instrumentation=self._instrumentation)

    def deserialize_session_state(self, payload: dict[str, object]) -> SandboxSessionState:
        return self._deserialize_session_state_payload(payload, SolariSandboxSessionState)


__all__ = [
    "SolariSandboxClient",
    "SolariSandboxClientOptions",
    "SolariSandboxSession",
    "SolariSandboxSessionState",
    "SolariTimeouts",
]
