import unittest

from reprolab.models import RunSpec


def valid_spec() -> dict:
    return {
        "schema_version": "1.0",
        "recipe": "csv_identifier_libreoffice",
        "target_url": "https://example.com/report",
        "profile_id": None,
        "page_assertion": {"title": "Report", "contains_text": "September"},
        "row_selector": {"customer": "Northstar Labs"},
        "target_column": "account_code",
        "target_cell": "A2",
        "expected_text": "001234",
        "known_failure_text": "1234",
    }


class RunSpecTests(unittest.TestCase):
    def test_supported_recipe_is_accepted(self) -> None:
        self.assertEqual(RunSpec.from_dict(valid_spec()).target_cell, "A2")

    def test_unsupported_recipe_is_rejected(self) -> None:
        value = valid_spec()
        value["recipe"] = "arbitrary_desktop_agent"
        with self.assertRaisesRegex(ValueError, "unsupported recipe"):
            RunSpec.from_dict(value)

    def test_missing_required_assertion_is_rejected(self) -> None:
        value = valid_spec()
        value["page_assertion"] = {"title": "", "contains_text": ""}
        with self.assertRaisesRegex(ValueError, "page_assertion"):
            RunSpec.from_dict(value)

    def test_missing_row_assertion_is_rejected(self) -> None:
        value = valid_spec()
        value["row_selector"] = {}
        with self.assertRaisesRegex(ValueError, "row_selector"):
            RunSpec.from_dict(value)


if __name__ == "__main__":
    unittest.main()
