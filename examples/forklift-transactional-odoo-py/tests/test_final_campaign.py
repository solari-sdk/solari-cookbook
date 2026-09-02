from __future__ import annotations

import ast
import unittest
from pathlib import Path

from scripts.freeze_final_protocol import FROZEN_CODE_FILES, PROJECT_ROOT
from scripts.run_final_campaign import attempt_matches_expected
from scripts.run_final_campaign import retryable_pre_mutation_failure


class FinalCampaignTests(unittest.TestCase):
    def test_matches_bound_expected_acceptance(self) -> None:
        trial = {
            "case_digest": "case",
            "expected_acceptance": False,
            "fault_schedule_digest": "fault",
            "required_failed_codes": ["bill-count"],
        }
        payload = {
            "accepted": False,
            "failed_codes": ["bill-count"],
            "oracle_checks": [{"passed": False}],
            "protocol_passed": True,
            "receipt": {
                "case_digest": "case",
                "fault_schedule_digest": "fault",
            },
        }
        self.assertTrue(attempt_matches_expected(payload, trial))
        self.assertFalse(attempt_matches_expected({**payload, "accepted": True}, trial))
        self.assertFalse(
            attempt_matches_expected({**payload, "failed_codes": []}, trial)
        )

    def test_final_retry_is_only_for_clean_pre_mutation_failures(self) -> None:
        self.assertTrue(
            retryable_pre_mutation_failure(
                {
                    "trial": "failed",
                    "business_mutation_observed": False,
                    "fault_triggered": [],
                }
            )
        )
        self.assertFalse(
            retryable_pre_mutation_failure(
                {
                    "trial": "failed",
                    "business_mutation_observed": True,
                    "fault_triggered": [],
                }
            )
        )
        self.assertFalse(
            retryable_pre_mutation_failure(
                {
                    "trial": "failed",
                    "business_mutation_observed": False,
                    "fault_triggered": ["kill-worker"],
                }
            )
        )

    def test_frozen_manifest_covers_local_import_closure(self) -> None:
        frozen = set(FROZEN_CODE_FILES)
        for relative in FROZEN_CODE_FILES:
            if not relative.endswith(".py"):
                continue
            source = (PROJECT_ROOT / relative).read_text(encoding="utf-8")
            module_parts = list(Path(relative).with_suffix("").parts)
            tree = ast.parse(source)
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom) or node.module is None:
                    continue
                if node.level:
                    imported_parts = module_parts[:-node.level] + node.module.split(".")
                    imported = "/".join(imported_parts) + ".py"
                elif node.module.startswith(("forklift.", "scripts.")):
                    imported = node.module.replace(".", "/") + ".py"
                else:
                    continue
                if (PROJECT_ROOT / imported).exists():
                    self.assertIn(imported, frozen, f"unfrozen local import: {imported}")


if __name__ == "__main__":
    unittest.main()
