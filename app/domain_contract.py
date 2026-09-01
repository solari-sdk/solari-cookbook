from __future__ import annotations

from copy import deepcopy
from typing import Any

from app.contracts import AcquisitionEnvelope, CaseRecord, EntityRecord, EventRecord, RelationshipRecord, SourceDescriptor
from app.observables import ObservableRecord

DOMAIN_CONTRACT_NAME = "solari-osint-domain"
DOMAIN_CONTRACT_VERSION = 1
PORTABLE_CASE_FORMAT = "solari-portable-case"
PORTABLE_CASE_VERSION = 3

_MODEL_TYPES = {
    "event": EventRecord,
    "source": SourceDescriptor,
    "acquisition": AcquisitionEnvelope,
    "entity": EntityRecord,
    "relationship": RelationshipRecord,
    "case": CaseRecord,
    "observable": ObservableRecord,
}


def _model_contract(model: type) -> dict[str, Any]:
    fields = model.model_fields
    return {
        "fields": list(fields),
        "required": [name for name, field in fields.items() if field.is_required()],
    }


def build_domain_contract() -> dict[str, Any]:
    """Build the small compatibility contract shared by server and static clients.

    Full validation remains with the Pydantic/JSON-Schema models on the server and
    the bounded portable-case validator in the browser. This manifest exists to
    prevent those two execution modes from silently drifting on object names,
    field names, required fields, or portable-case versioning.
    """
    return {
        "contract": DOMAIN_CONTRACT_NAME,
        "version": DOMAIN_CONTRACT_VERSION,
        "portable_case": {
            "format": PORTABLE_CASE_FORMAT,
            "version": PORTABLE_CASE_VERSION,
        },
        "models": {name: _model_contract(model) for name, model in _MODEL_TYPES.items()},
    }


def validate_domain_contract(payload: dict[str, Any]) -> dict[str, Any]:
    expected = build_domain_contract()
    if payload != expected:
        raise ValueError("shared domain contract does not match current server models")
    return deepcopy(payload)
