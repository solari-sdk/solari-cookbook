from __future__ import annotations

import json
from pathlib import Path

from app.domain_contract import build_domain_contract

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "static-console" / "domain-contract.json"


def main() -> int:
    payload = build_domain_contract()
    OUTPUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
