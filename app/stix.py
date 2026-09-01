from __future__ import annotations

import ipaddress
from uuid import NAMESPACE_URL, uuid4, uuid5
from typing import Any, Iterable

from app.observables import ObservableRecord, make_observable

MAX_STIX_OBJECTS = 10_000


def _stix_id(object_type: str, canonical: str) -> str:
    return f"{object_type}--{uuid5(NAMESPACE_URL, f'stix:{object_type}:{canonical}')}"


def _hash_algorithm(value: str) -> str | None:
    length = len(value)
    return {32: "MD5", 40: "SHA-1", 64: "SHA-256", 128: "SHA-512"}.get(length)


def observable_to_stix(record: ObservableRecord) -> dict[str, Any] | None:
    common = {"spec_version": "2.1", "x_solari_confidence": record.confidence}
    if record.type == "domain":
        return {"type": "domain-name", "id": _stix_id("domain-name", record.canonical_value), "value": record.canonical_value, **common}
    if record.type == "ip":
        ip = ipaddress.ip_address(record.canonical_value)
        object_type = "ipv4-addr" if ip.version == 4 else "ipv6-addr"
        return {"type": object_type, "id": _stix_id(object_type, record.canonical_value), "value": record.canonical_value, **common}
    if record.type == "url":
        return {"type": "url", "id": _stix_id("url", record.canonical_value), "value": record.canonical_value, **common}
    if record.type == "email":
        return {"type": "email-addr", "id": _stix_id("email-addr", record.canonical_value), "value": record.canonical_value, **common}
    if record.type == "hash":
        algorithm = _hash_algorithm(record.canonical_value)
        if algorithm is None:
            return None
        return {"type": "file", "id": _stix_id("file", f"{algorithm}:{record.canonical_value}"), "hashes": {algorithm: record.canonical_value}, **common}
    return None


def export_stix_bundle(records: Iterable[ObservableRecord]) -> dict[str, Any]:
    objects=[]; skipped=[]
    for record in records:
        item=observable_to_stix(record)
        if item is None:
            skipped.append({"id": record.id, "type": record.type, "reason": "no safe STIX mapping"})
        else:
            objects.append(item)
        if len(objects) > MAX_STIX_OBJECTS:
            raise ValueError("STIX export exceeds object safety limit")
    return {"type": "bundle", "id": f"bundle--{uuid4()}", "objects": objects, "x_solari_skipped": skipped}


def import_stix_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    if bundle.get("type") != "bundle" or not isinstance(bundle.get("objects"), list):
        raise ValueError("STIX input must be a bundle with an objects array")
    if len(bundle["objects"]) > MAX_STIX_OBJECTS:
        raise ValueError("STIX import exceeds object safety limit")
    records=[]; skipped=[]
    for item in bundle["objects"]:
        if not isinstance(item, dict):
            skipped.append({"reason": "non-object member"}); continue
        object_type=item.get("type"); value=item.get("value"); observable_type=None
        if object_type == "domain-name": observable_type="domain"
        elif object_type in {"ipv4-addr","ipv6-addr"}: observable_type="ip"
        elif object_type == "url": observable_type="url"
        elif object_type == "email-addr": observable_type="email"
        elif object_type == "file" and isinstance(item.get("hashes"),dict) and item["hashes"]:
            preferred=next((name for name in ("SHA-256","SHA-512","SHA-1","MD5") if name in item["hashes"]),None)
            if preferred: observable_type="hash"; value=item["hashes"][preferred]
        if observable_type is None or not isinstance(value,str):
            skipped.append({"id": item.get("id"), "type": object_type, "reason": "unsupported or incomplete STIX object"}); continue
        confidence=float(item.get("x_solari_confidence",1.0)); confidence=max(0.0,min(1.0,confidence))
        try:
            records.append(make_observable(observable_type,value,confidence=confidence,properties={"stix_id":item.get("id"),"stix_type":object_type}))
        except (ValueError,TypeError) as exc:
            skipped.append({"id":item.get("id"),"type":object_type,"reason":type(exc).__name__})
    return {"records": records, "skipped": skipped}
