import os

import pytest

from app.solari.sandbox import build_json_transform_program, run_python_sync


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
