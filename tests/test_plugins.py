import pytest

from app.plugins import PluginKind, PluginManifest, PluginRegistry, _sandbox_program


def test_plugin_registry_discovers_kind_and_capability() -> None:
    registry = PluginRegistry()
    registry.register(PluginManifest(id="geo.enricher", name="Geo enricher", version="1.0.0", kind=PluginKind.ANALYZER, capabilities=["geospatial"]))
    registry.register(PluginManifest(id="case.export", name="Case exporter", version="1.0.0", kind=PluginKind.EXPORTER, capabilities=["portable-case"]))
    assert [item.id for item in registry.discover(kind=PluginKind.ANALYZER)] == ["geo.enricher"]
    assert [item.id for item in registry.discover(capability="portable-case")] == ["case.export"]
    with pytest.raises(ValueError):
        registry.register(PluginManifest(id="geo.enricher", name="Duplicate", version="1", kind=PluginKind.ANALYZER))


def test_plugin_manifest_bounds_and_program_output_limit() -> None:
    manifest = PluginManifest(id="safe.plugin", name="Safe", version="1", kind=PluginKind.ANALYZER, timeout_seconds=5, max_output_bytes=2048)
    program = _sandbox_program({"value": 1}, "def analyze(payload):\n    return payload", manifest.max_output_bytes)
    assert "MAX_OUTPUT = 2048" in program
    assert "plugin output exceeds configured limit" in program
    with pytest.raises(ValueError):
        PluginManifest(id="bad", name="Bad", version="1", kind=PluginKind.ANALYZER, timeout_seconds=0)
