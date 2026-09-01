from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


@dataclass(frozen=True, slots=True)
class NormalizedTime:
    utc: datetime
    original: str
    timezone_provenance: str
    assumed_timezone: bool

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        data["utc"] = self.utc.isoformat()
        return data


def normalize_source_time(value: str | datetime, *, assumed_timezone: str | None = None) -> NormalizedTime:
    original = value.isoformat() if isinstance(value, datetime) else value
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace("Z", "+00:00"))
    assumed = False
    if parsed.tzinfo is None:
        if not assumed_timezone:
            raise ValueError("naive timestamps require an explicit assumed_timezone")
        parsed = parsed.replace(tzinfo=ZoneInfo(assumed_timezone))
        provenance = f"assumed:{assumed_timezone}"
        assumed = True
    else:
        offset = parsed.utcoffset()
        provenance = f"source-offset:{offset}" if offset is not None else "source-timezone"
    return NormalizedTime(
        utc=parsed.astimezone(timezone.utc),
        original=original,
        timezone_provenance=provenance,
        assumed_timezone=assumed,
    )
