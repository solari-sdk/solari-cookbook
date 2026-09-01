from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Iterable, Literal

RuleKind = Literal["event-pair", "source-pair", "category-pair"]


@dataclass(frozen=True, slots=True)
class SuppressionRule:
    id: str
    kind: RuleKind
    left: str
    right: str
    reason: str
    enabled: bool = True

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _unordered_pair(left: str, right: str) -> tuple[str, str]:
    return tuple(sorted((left, right)))


def correlation_suppression(candidate: dict[str, Any], rules: Iterable[SuppressionRule]) -> dict[str, Any]:
    """Evaluate an explainable suppression list without deleting the candidate."""
    event_pair = _unordered_pair(str(candidate.get("left_event_id", "")), str(candidate.get("right_event_id", "")))
    source_pair = _unordered_pair(str(candidate.get("left_source_id", "")), str(candidate.get("right_source_id", "")))
    category_pair = _unordered_pair(str(candidate.get("left_category", "")), str(candidate.get("right_category", "")))
    matches: list[dict[str, object]] = []
    for rule in rules:
        if not rule.enabled:
            continue
        rule_pair = _unordered_pair(rule.left, rule.right)
        actual = event_pair if rule.kind == "event-pair" else source_pair if rule.kind == "source-pair" else category_pair
        if actual == rule_pair:
            matches.append(rule.to_dict())
    return {"suppressed": bool(matches), "matches": matches, "candidate": candidate}


def filter_unsuppressed(candidates: Iterable[dict[str, Any]], rules: Iterable[SuppressionRule]) -> dict[str, list[dict[str, Any]]]:
    rule_items = list(rules)
    kept: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    for candidate in candidates:
        decision = correlation_suppression(candidate, rule_items)
        if decision["suppressed"]:
            suppressed.append(decision)
        else:
            kept.append(candidate)
    return {"kept": kept, "suppressed": suppressed}
