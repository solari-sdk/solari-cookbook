from __future__ import annotations

import json
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from app.solari.sandbox import SandboxExecution, run_python_sync


class PluginKind(str, Enum):
    INGESTOR = "ingestor"
    ANALYZER = "analyzer"
    VISUALIZER = "visualizer"
    EXPORTER = "exporter"
    CONNECTOR = "connector"


ENTRYPOINTS: dict[PluginKind, str] = {
    PluginKind.INGESTOR: "ingest",
    PluginKind.ANALYZER: "analyze",
    PluginKind.VISUALIZER: "visualize",
    PluginKind.EXPORTER: "export",
    PluginKind.CONNECTOR: "connect",
}


class PluginManifest(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,63}$")
    name: str
    version: str
    kind: PluginKind
    capabilities: list[str] = Field(default_factory=list)
    timeout_seconds: int = Field(default=30, ge=1, le=300)
    max_output_bytes: int = Field(default=1_000_000, ge=1024, le=10_000_000)
    sandbox_required: bool = True


class PluginRegistry:
    def __init__(self) -> None:
        self._plugins: dict[str, PluginManifest] = {}

    def register(self, manifest: PluginManifest) -> None:
        if manifest.id in self._plugins:
            raise ValueError(f"plugin already registered: {manifest.id}")
        self._plugins[manifest.id] = manifest

    def discover(self, *, kind: PluginKind | None = None, capability: str | None = None) -> list[PluginManifest]:
        plugins = self._plugins.values()
        if kind is not None:
            plugins = [plugin for plugin in plugins if plugin.kind is kind]
        if capability is not None:
            plugins = [plugin for plugin in plugins if capability in plugin.capabilities]
        return sorted(plugins, key=lambda plugin: plugin.id)


def plugin_entrypoint(kind: PluginKind) -> str:
    return ENTRYPOINTS[kind]


def _sandbox_program(payload: dict[str, Any], plugin_code: str, max_output_bytes: int, entrypoint: str = "analyze") -> str:
    if entrypoint not in set(ENTRYPOINTS.values()):
        raise ValueError("unsupported plugin entrypoint")
    serialized = json.dumps(payload, ensure_ascii=False)
    return (
        "import json\n"
        f"payload = json.loads({serialized!r})\n"
        f"MAX_OUTPUT = {max_output_bytes}\n"
        + plugin_code
        + f"\nresult = {entrypoint}(payload)\n"
        "encoded = json.dumps(result, ensure_ascii=False, sort_keys=True).encode('utf-8')\n"
        "if len(encoded) > MAX_OUTPUT: raise ValueError('plugin output exceeds configured limit')\n"
        "print(encoded.decode('utf-8'))\n"
    )


def run_sandbox_plugin(manifest: PluginManifest, plugin_code: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not manifest.sandbox_required:
        raise ValueError("this runner accepts sandbox-required plugins only")
    entrypoint = plugin_entrypoint(manifest.kind)
    if f"def {entrypoint}(" not in plugin_code:
        raise ValueError(f"{manifest.kind.value} plugin code must define {entrypoint}(payload)")
    execution: SandboxExecution = run_python_sync(
        _sandbox_program(payload, plugin_code, manifest.max_output_bytes, entrypoint),
        timeout_ms=manifest.timeout_seconds * 1000,
    )
    parsed = None
    if not execution.error:
        lines = [line.strip() for line in execution.stdout if line.strip()]
        if lines:
            parsed = json.loads(lines[-1])
    return {
        "plugin_id": manifest.id,
        "plugin_version": manifest.version,
        "plugin_kind": manifest.kind.value,
        "entrypoint": entrypoint,
        "sandbox_id": execution.sandbox_id,
        "duration_ms": execution.duration_ms,
        "stdout": execution.stdout,
        "stderr": execution.stderr,
        "error": execution.error,
        "result": parsed,
    }
