import argparse
import json
from types import SimpleNamespace

import pytest

from main import (
    RESULT_MARKER,
    classify_runs,
    enrich_results,
    extract_payload,
    github_repo_url,
    render_markdown,
)


def outcomes(*statuses):
    return [{"status": status} for status in statuses]


@pytest.mark.parametrize(
    ("runs", "expected"),
    [
        (outcomes("passed", "passed"), "stable-pass"),
        (outcomes("failed", "failed"), "stable-fail"),
        (outcomes("passed", "failed"), "flaky"),
        (outcomes("timeout", "timeout"), "timeout"),
        (outcomes("failed", "error"), "error"),
    ],
)
def test_classify_runs(runs, expected):
    assert classify_runs(runs) == expected


def test_github_repo_url_accepts_public_https_url():
    assert (
        github_repo_url("https://github.com/example/project.git")
        == "https://github.com/example/project.git"
    )


@pytest.mark.parametrize(
    "value",
    [
        "git@github.com:example/project.git",
        "https://example.com/project",
        "https://github.com/only-owner",
    ],
)
def test_github_repo_url_rejects_unsupported_values(value):
    with pytest.raises(argparse.ArgumentTypeError):
        github_repo_url(value)


def test_extract_payload_uses_last_marker():
    payload = {"tests": [], "source": "demo"}
    result = SimpleNamespace(
        error=None,
        results=[
            SimpleNamespace(text="setup output"),
            SimpleNamespace(text=RESULT_MARKER + json.dumps(payload)),
        ],
    )
    assert extract_payload(result) == payload


def test_enrich_results_and_markdown_report():
    payload = {
        "source": "demo",
        "requested_runs": 2,
        "tests": [
            {"node_id": "test_demo.py::test_flake", "runs": outcomes("passed", "failed")},
            {"node_id": "test_demo.py::test_ok", "runs": outcomes("passed", "passed")},
        ],
    }
    enriched = enrich_results(payload)
    report = render_markdown(enriched)

    assert enriched["summary"]["flaky"] == 1
    assert enriched["summary"]["stable-pass"] == 1
    assert "test_demo.py::test_flake" in report
    assert "**flaky**" in report
