import json
from pathlib import Path

from app.contracts import AcquisitionEnvelope, EventRecord


def test_checked_in_sample_output_matches_public_contracts():
    path = Path(__file__).parents[1] / "samples" / "normalized-public-source.sample.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["sample_format"] == "solari-normalized-public-source-fixture"
    acquisition = AcquisitionEnvelope.model_validate(data["acquisition"])
    events = [EventRecord.model_validate(item) for item in data["events"]]
    assert acquisition.metadata["fixture"] is True
    assert len(events) == 1
    assert events[0].evidence[0].acquisition_id == acquisition.id
    assert events[0].properties["fixture"] is True
