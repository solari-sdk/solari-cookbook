from datetime import datetime, timezone

import pytest

from app.collaboration import add_handoff, assign_case, list_audit, list_handoffs, list_reviews, list_views, record_audit, record_review, save_view, work_queue
from app.contracts import CaseRecord
from app.storage import save_case


def _case(case_id="case-1"):
    now=datetime.now(timezone.utc)
    return CaseRecord(id=case_id,title="Public case",created_at=now,updated_at=now)


def test_audit_is_append_only_and_hashes_before_after(tmp_path):
    db=tmp_path/"collab.sqlite3"
    record_audit("entity_reviewed",actor="analyst",target_type="entity",target_id="e1",correlation_id="corr-1",before={"status":"pending"},after={"status":"approved"},path=db)
    rows=list_audit(target_type="entity",target_id="e1",path=db)
    assert len(rows)==1
    assert rows[0]["before_hash"] != rows[0]["after_hash"]
    assert rows[0]["correlation_id"] == "corr-1"


def test_saved_views_reject_sensitive_state(tmp_path):
    db=tmp_path/"collab.sqlite3"
    save_view("v1","Map",{"filters":{"category":"earthquake"}},case_id="case-1",path=db)
    assert list_views(case_id="case-1",path=db)[0]["state"]["filters"]["category"] == "earthquake"
    with pytest.raises(ValueError):
        save_view("bad","Unsafe",{"api_token":"not-a-real-secret"},path=db)


def test_assignment_queue_handoff_and_review(tmp_path):
    db=tmp_path/"collab.sqlite3"; save_case(_case(),db); save_case(_case("case-2"),db)
    assign_case("case-1","analyst",priority=50,path=db)
    assign_case("case-2","analyst",priority=10,path=db)
    queue=work_queue("analyst",path=db)
    assert [item["case_id"] for item in queue] == ["case-2","case-1"]
    handoff=add_handoff("case-1","Check source provenance",author="analyst",recipient="reviewer",path=db)
    assert list_handoffs("case-1",path=db)[0]["id"] == handoff["id"]
    review=record_review("relationship","r1","needs_changes",case_id="case-1",reviewer="reviewer",note="Need a second source",path=db)
    assert list_reviews("relationship","r1",path=db)[0]["id"] == review["id"]
