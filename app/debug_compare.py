from __future__ import annotations

from copy import deepcopy
from typing import Any


def _path_get(value: object, path: str) -> object:
    current = value
    for part in path.split(".") if path else []:
        if isinstance(current, dict):
            if part not in current:
                raise KeyError(path)
            current = current[part]
        elif isinstance(current, list) and part.isdigit():
            current = current[int(part)]
        else:
            raise KeyError(path)
    return current


def compare_raw_normalized(
    raw_record: dict[str, Any],
    normalized_record: dict[str, Any],
    field_map: dict[str, str],
) -> list[dict[str, object]]:
    """Expose raw-to-normalized field mappings for debugging without modifying either record."""
    output: list[dict[str, object]] = []
    for normalized_field, raw_path in sorted(field_map.items()):
        raw_missing = False
        normalized_missing = False
        try:
            raw_value = _path_get(raw_record, raw_path)
        except (KeyError, IndexError):
            raw_missing = True
            raw_value = None
        try:
            normalized_value = _path_get(normalized_record, normalized_field)
        except (KeyError, IndexError):
            normalized_missing = True
            normalized_value = None
        output.append({
            "normalized_field": normalized_field,
            "raw_path": raw_path,
            "raw_value": deepcopy(raw_value),
            "normalized_value": deepcopy(normalized_value),
            "raw_missing": raw_missing,
            "normalized_missing": normalized_missing,
            "changed": raw_missing or normalized_missing or raw_value != normalized_value,
        })
    return output
