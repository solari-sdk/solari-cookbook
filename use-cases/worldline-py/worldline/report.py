"""Static interactive report generation."""

from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path

from .models import RunResult


def write_report(run: RunResult, artifact_dir: Path) -> Path:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    (artifact_dir / "run.json").write_text(
        json.dumps(run.to_dict(), indent=2, sort_keys=True),
        encoding="utf-8",
    )
    static_dir = files("worldline").joinpath("static")
    for name in ("index.html", "app.js", "styles.css"):
        with static_dir.joinpath(name).open("rb") as source:
            (artifact_dir / name).write_bytes(source.read())
    return artifact_dir / "index.html"
