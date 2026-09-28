"""Regression Case Store for Fault Line."""

from __future__ import annotations

import json
from pathlib import Path

from .models import RegressionCase


class RegressionCaseStore:
    """Manages persistent regression test cases."""

    def __init__(self, store_path: Path | None = None):
        if store_path is None:
            store_path = Path(__file__).parent.parent / "results" / "regression_cases.json"
        self.store_path = store_path
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.store_path.exists():
            self.store_path.write_text("[]", encoding="utf-8")

    def save_case(self, case: RegressionCase) -> None:
        cases = self.list_cases_raw()
        # Remove duplicate case_id if re-saved
        cases = [c for c in cases if c.get("case_id") != case.case_id]
        cases.append(case.to_dict())
        self.store_path.write_text(json.dumps(cases, indent=2), encoding="utf-8")

    def list_cases_raw(self) -> list[dict]:
        try:
            return json.loads(self.store_path.read_text(encoding="utf-8"))
        except Exception:
            return []

    def get_case(self, case_id: str) -> dict | None:
        cases = self.list_cases_raw()
        for c in cases:
            if c.get("case_id") == case_id:
                return c
        return None
