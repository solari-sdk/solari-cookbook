"""Build a hashed Odoo runtime containing only the verified module closure."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import psycopg


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = PROJECT_ROOT / "artifacts" / "development"
ARCHIVE = OUTPUT_DIR / "odoo-runtime.tar.gz"
MANIFEST = OUTPUT_DIR / "odoo-runtime.manifest.json"
CONTAINER = "forklift-web-1"
GUEST_STAGE = "/tmp/forklift-odoo-runtime-stage"
GUEST_ARCHIVE = "/tmp/forklift-odoo-runtime.tar.gz"


def _run(args: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=True,
        capture_output=capture,
        text=True,
    )


def _installed_modules() -> list[str]:
    with psycopg.connect(
        "postgresql://odoo:odoo@127.0.0.1:5433/forklift_clean"
    ) as connection:
        return [
            row[0]
            for row in connection.execute(
                "select name from ir_module_module where state='installed' order by name"
            ).fetchall()
        ]


def main() -> None:
    installed = _installed_modules()
    guest_builder = r"""
import json
import ast
import re
import shutil
import sys
from pathlib import Path

source = Path('/usr/lib/python3/dist-packages/odoo')
stage = Path(sys.argv[1])
installed = json.loads(sys.argv[2])
available = {p.name: p for p in (source / 'addons').iterdir() if p.is_dir()}
selected = set(installed)
reasons = {name: {'installed'} for name in installed}

def include(name, reason):
    if name not in available:
        return False
    before = len(selected)
    selected.add(name)
    reasons.setdefault(name, set()).add(reason)
    return len(selected) != before

changed = True
while changed:
    changed = False
    for name in sorted(selected):
        addon = available[name]
        manifest_path = addon / '__manifest__.py'
        if manifest_path.exists():
            try:
                manifest = ast.literal_eval(manifest_path.read_text(encoding='utf-8'))
            except (SyntaxError, ValueError):
                manifest = {}
            for dependency in manifest.get('depends', []):
                changed |= include(dependency, f'manifest:{name}')
        for python_file in addon.rglob('*.py'):
            relative_parts = python_file.relative_to(addon).parts
            if any(part in {'tests', 'migrations', 'static'} for part in relative_parts):
                continue
            try:
                code = python_file.read_text(encoding='utf-8')
            except UnicodeDecodeError:
                continue
            for imported in re.findall(r'\bodoo\.addons\.([A-Za-z_][A-Za-z0-9_]*)', code):
                changed |= include(imported, f'import:{name}')
            try:
                tree = ast.parse(code)
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module == 'odoo.addons':
                    for alias in node.names:
                        changed |= include(alias.name, f'import:{name}')

if stage.exists():
    shutil.rmtree(stage)
target = stage / 'odoo'
target.mkdir(parents=True)
for child in source.iterdir():
    if child.name == 'addons':
        continue
    destination = target / child.name
    if child.is_dir():
        shutil.copytree(child, destination, symlinks=True)
    else:
        shutil.copy2(child, destination, follow_symlinks=False)
(target / 'addons').mkdir()
missing = []
for name in sorted(selected):
    addon = source / 'addons' / name
    if not addon.is_dir():
        missing.append(name)
        continue
    shutil.copytree(addon, target / 'addons' / name, symlinks=True)
if missing:
    raise SystemExit('missing selected addons: ' + ','.join(missing))
print(json.dumps({
    'runtime_modules': sorted(selected),
    'additional_code_modules': sorted(selected - set(installed)),
    'selection_reasons': {name: sorted(values) for name, values in sorted(reasons.items())},
}, sort_keys=True))
"""

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    build_result = _run(
        [
            "docker",
            "exec",
            CONTAINER,
            "python3",
            "-c",
            guest_builder,
            GUEST_STAGE,
            json.dumps(installed, separators=(",", ":")),
        ],
        capture=True,
    )
    bundle_info = json.loads(build_result.stdout)
    try:
        _run(
            [
                "docker",
                "exec",
                CONTAINER,
                "tar",
                "-C",
                GUEST_STAGE,
                "-czf",
                GUEST_ARCHIVE,
                "odoo",
            ]
        )
        temporary = ARCHIVE.with_suffix(".tar.gz.partial")
        if temporary.exists():
            temporary.unlink()
        _run(["docker", "cp", f"{CONTAINER}:{GUEST_ARCHIVE}", str(temporary)])
        temporary.replace(ARCHIVE)
    finally:
        _run(
            [
                "docker",
                "exec",
                CONTAINER,
                "rm",
                "-rf",
                GUEST_STAGE,
                GUEST_ARCHIVE,
            ]
        )

    digest = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
    manifest = {
        "archive": ARCHIVE.name,
        "bytes": ARCHIVE.stat().st_size,
        "additional_code_modules": bundle_info["additional_code_modules"],
        "installed_modules": installed,
        "installed_module_count": len(installed),
        "module_count": len(bundle_info["runtime_modules"]),
        "runtime_modules": bundle_info["runtime_modules"],
        "selection_reasons": bundle_info["selection_reasons"],
        "sha256": digest,
        "source_container": CONTAINER,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(manifest, sort_keys=True))


if __name__ == "__main__":
    main()
