import json

import pytest

import app.solari.sandbox as sandbox_module
from app.solari.sandbox import (
    build_geospatial_enrichment_program,
    build_json_transform_program,
    run_python_steps_sync,
    run_python_sync,
)


def test_sandbox_requires_api_key(monkeypatch):
    monkeypatch.delenv("SOLARI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="SOLARI_API_KEY"):
        run_python_sync("print('hello')")


def test_build_json_transform_program():
    program = build_json_transform_program({"values": [1, 2, 3]}, "sum(data['values'])")
    assert "json.loads" in program
    assert "sum(data['values'])" in program
    assert "sort_keys=True" in program


def test_empty_transform_expression_rejected():
    with pytest.raises(ValueError):
        build_json_transform_program({}, "   ")


def test_geospatial_enrichment_program_is_bounded_and_deterministic():
    program = build_geospatial_enrichment_program([
        {"latitude": 47.6062, "longitude": -122.3321},
        {"latitude": 45.5152, "longitude": -122.6784},
    ])
    assert "segment_distances_km" in program
    assert "total_distance_km" in program
    assert "6371.0088" in program
    with pytest.raises(ValueError):
        build_geospatial_enrichment_program([{"latitude": 47.0, "longitude": -122.0}])
    with pytest.raises(ValueError):
        build_geospatial_enrichment_program([
            {"latitude": 91.0, "longitude": 0.0},
            {"latitude": 0.0, "longitude": 0.0},
        ])


class _OutputItem:
    type = "stdout"
    def __init__(self, text): self.text = text


class _Output:
    error = None
    def __init__(self, text): self.results = [_OutputItem(text)]


class _FakeSandbox:
    sandboxId = "sandbox-stateful-test"
    def __init__(self):
        self.contexts = []
        self.run_contexts = []
        self.killed = False
    async def connect(self): pass
    async def create_code_context(self, language):
        assert language == "python"
        self.contexts.append("ctx-1")
        return "ctx-1"
    async def run_code(self, code, context_id):
        self.run_contexts.append(context_id)
        return _Output(json.dumps({"code": code, "context": context_id}))
    async def kill(self): self.killed = True


class _FakeSandboxClient:
    instances = []
    def __init__(self, api_key, base_url):
        assert api_key == "test-key"
        self.sandbox = _FakeSandbox()
        self.__class__.instances.append(self)
    async def __aenter__(self): return self
    async def __aexit__(self, exc_type, exc, tb): return False
    async def create(self, template, timeout_ms):
        assert template == "base"
        assert timeout_ms == 5000
        return self.sandbox


def test_stateful_sandbox_reuses_one_context_and_cleans_up(monkeypatch):
    _FakeSandboxClient.instances.clear()
    monkeypatch.setenv("SOLARI_API_KEY", "test-key")
    monkeypatch.setattr(sandbox_module, "SandboxClient", _FakeSandboxClient)
    result = run_python_steps_sync(["x=1", "print(x+1)"], timeout_ms=5000)
    fake = _FakeSandboxClient.instances[-1].sandbox
    assert result.sandbox_id == "sandbox-stateful-test"
    assert len(result.steps) == 2
    assert fake.contexts == ["ctx-1"]
    assert fake.run_contexts == ["ctx-1", "ctx-1"]
    assert fake.killed is True


def test_stateful_sandbox_step_count_is_bounded(monkeypatch):
    monkeypatch.setenv("SOLARI_API_KEY", "test-key")
    with pytest.raises(ValueError, match="between 1 and"):
        run_python_steps_sync([])
    with pytest.raises(ValueError, match="between 1 and"):
        run_python_steps_sync(["pass"] * (sandbox_module.MAX_STATEFUL_STEPS + 1))
