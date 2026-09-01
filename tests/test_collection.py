from types import SimpleNamespace

import pytest

from app.collection import collect_many
from app.contracts import AcquisitionEnvelope, AcquisitionMethod, EventRecord, utc_now


def adapter(source_id: str, *, fail: bool = False):
    def collect():
        if fail:
            raise TimeoutError("fixture timeout")
        now = utc_now()
        acquisition = AcquisitionEnvelope(
            id=f"acq-{source_id}", source_id=source_id, method=AcquisitionMethod.API,
            requested_url="https://example.org/public.json", final_url="https://example.org/public.json",
            started_at=now, completed_at=now, status="success", http_status=200,
        )
        event = EventRecord(id=f"event-{source_id}", source_id=source_id, source_record_id="1", category="fixture", title="Fixture", observed_at=now)
        return acquisition, [event]
    return SimpleNamespace(collect=collect)


def test_collect_many_preserves_requested_order_and_failures() -> None:
    adapters={"a":adapter("a"),"b":adapter("b",fail=True),"c":adapter("c")}
    results=collect_many(adapters,["c","b","a"],max_workers=2)
    assert [result.source_id for result in results]==["c","b","a"]
    assert results[0].succeeded
    assert not results[1].succeeded
    assert results[1].error_type=="TimeoutError"
    assert results[2].events[0].id=="event-a"


def test_collect_many_validates_bounds_and_sources() -> None:
    with pytest.raises(ValueError): collect_many({"a":adapter("a")},[],max_workers=1)
    with pytest.raises(ValueError): collect_many({"a":adapter("a")},["a"],max_workers=17)
    with pytest.raises(KeyError): collect_many({"a":adapter("a")},["missing"],max_workers=1)
