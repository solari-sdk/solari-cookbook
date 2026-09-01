import json
from pathlib import Path

from app.domain_contract import build_domain_contract, validate_domain_contract


def test_checked_in_static_contract_matches_server_models():
    root = Path(__file__).parents[1]
    payload = json.loads((root / "static-console" / "domain-contract.json").read_text(encoding="utf-8"))
    assert validate_domain_contract(payload) == build_domain_contract()
    assert payload["portable_case"] == {"format": "solari-portable-case", "version": 3}
    assert payload["models"]["event"]["required"] == [
        "id",
        "source_id",
        "source_record_id",
        "category",
        "title",
        "observed_at",
    ]


def test_shared_contract_covers_server_and_portable_object_types():
    contract = build_domain_contract()
    assert set(contract["models"]) == {
        "event",
        "source",
        "acquisition",
        "entity",
        "relationship",
        "case",
        "observable",
    }
    for model in contract["models"].values():
        assert set(model["required"]).issubset(model["fields"])
