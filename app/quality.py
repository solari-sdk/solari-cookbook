from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from urllib.parse import urlparse


class WarningMatch(str, Enum):
    EXACT = "exact"
    SUBSTRING = "substring"
    HOSTNAME = "hostname"
    CIDR = "cidr"
    REGEX = "regex"


@dataclass(frozen=True, slots=True)
class WarningEntry:
    id: str
    pattern: str
    match: WarningMatch
    reason: str


def _hostname(value: str) -> str:
    parsed = urlparse(value if "://" in value else f"//{value}")
    return (parsed.hostname or value).strip(".").lower()


def warning_matches(value: str, entries: list[WarningEntry]) -> list[WarningEntry]:
    matches: list[WarningEntry] = []
    normalized = value.strip()
    for entry in entries:
        if entry.match is WarningMatch.EXACT and normalized == entry.pattern:
            matches.append(entry)
        elif entry.match is WarningMatch.SUBSTRING and entry.pattern in normalized:
            matches.append(entry)
        elif entry.match is WarningMatch.HOSTNAME:
            candidate = _hostname(normalized)
            pattern = _hostname(entry.pattern)
            if candidate == pattern or candidate.endswith(f".{pattern}"):
                matches.append(entry)
        elif entry.match is WarningMatch.CIDR:
            try:
                if ipaddress.ip_address(normalized) in ipaddress.ip_network(entry.pattern, strict=False):
                    matches.append(entry)
            except ValueError:
                continue
        elif entry.match is WarningMatch.REGEX:
            if re.search(entry.pattern, normalized):
                matches.append(entry)
    return matches


def completeness_score(required_fields: list[str], record: dict[str, object]) -> float:
    if not required_fields:
        return 1.0
    present = sum(1 for field in required_fields if record.get(field) not in (None, "", [], {}))
    return present / len(required_fields)


def staleness_score(observed_at: datetime, *, fresh_seconds: int, now: datetime | None = None) -> float:
    if fresh_seconds <= 0:
        raise ValueError("fresh_seconds must be positive")
    now = now or datetime.now(timezone.utc)
    if observed_at.tzinfo is None:
        observed_at = observed_at.replace(tzinfo=timezone.utc)
    age = max(0.0, (now - observed_at).total_seconds())
    return max(0.0, min(1.0, 1.0 - age / fresh_seconds))


def aggregate_confidence(source_reliability: float, record_quality: float, corroboration: float = 1.0) -> float:
    for value in (source_reliability, record_quality, corroboration):
        if not 0.0 <= value <= 1.0:
            raise ValueError("confidence inputs must be between 0 and 1")
    return round((source_reliability * record_quality * corroboration) ** (1 / 3), 6)
