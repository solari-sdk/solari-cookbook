import json

from app.jobs_api import _sse_event


def test_sse_event_is_single_safe_json_frame():
    frame = _sse_event("job-metrics", {"value": "line one\nline two", "count": 2})
    assert frame.startswith("event: job-metrics\ndata: ")
    assert frame.endswith("\n\n")
    data_line = frame.splitlines()[1].removeprefix("data: ")
    payload = json.loads(data_line)
    assert payload == {"count": 2, "value": "line one\nline two"}
