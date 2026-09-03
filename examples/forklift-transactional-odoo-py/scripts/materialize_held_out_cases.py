"""Materialize digest-bound development cases without revealing the seed."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from forklift.case_generation import case_digest, case_payload, generate_cases, manifest_digest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = PROJECT_ROOT / "artifacts" / "development" / "held-out-cases"


def materialize(*, seed: str, count: int, namespace: str, output_dir: Path) -> dict[str, object]:
    cases = generate_cases(seed=seed, count=count, namespace=namespace)
    output_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, object]] = []
    for index, case in enumerate(cases, start=1):
        payload = case_payload(case)
        filename = f"case-{index:03d}-{case_digest(case)[:12]}.json"
        path = output_dir / filename
        path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        rows.append(
            {
                "case_digest": case_digest(case),
                "file": filename,
                "receipt_mode": (
                    "zero"
                    if not case.billable
                    else "full"
                    if case.received_qty == case.ordered_qty
                    else "partial"
                ),
            }
        )

    manifest = {
        "case_count": len(cases),
        "cases": rows,
        "generator": "forklift.case_generation.generate_cases",
        "manifest_digest": manifest_digest(cases),
        "namespace": namespace,
        "seed_sha256": hashlib.sha256(seed.encode("utf-8")).hexdigest(),
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=6)
    parser.add_argument("--namespace", default="development-hidden")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--seed-env", default="FORKLIFT_DEVELOPMENT_SEED")
    args = parser.parse_args()
    seed = os.environ.get(args.seed_env, "")
    if not seed:
        print(json.dumps({"materialized": False, "reason": "missing_seed_environment"}))
        return 2
    manifest = materialize(
        seed=seed,
        count=args.count,
        namespace=args.namespace,
        output_dir=args.output,
    )
    print(
        json.dumps(
            {
                "case_count": manifest["case_count"],
                "manifest_digest": manifest["manifest_digest"],
                "materialized": True,
                "receipt_modes": [row["receipt_mode"] for row in manifest["cases"]],
                "seed_sha256": manifest["seed_sha256"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
