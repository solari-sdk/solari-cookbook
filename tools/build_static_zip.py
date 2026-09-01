from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "static-console"
DIST = ROOT / "dist"
OUTPUT = DIST / "solari-static-console.zip"


def build() -> Path:
    if not SOURCE.is_dir():
        raise SystemExit("static-console directory is missing")
    DIST.mkdir(exist_ok=True)
    with ZipFile(OUTPUT, "w", ZIP_DEFLATED) as archive:
        for path in sorted(SOURCE.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(ROOT))
    return OUTPUT


if __name__ == "__main__":
    print(build())
