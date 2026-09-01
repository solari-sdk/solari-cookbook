from datetime import datetime, timezone

from app.contracts import CaseRecord, EventRecord, EvidenceKind, EvidenceReference
from app.storage import add_case_object, save_case, save_events
from app.workspace import (
    add_correction_overlay,
    clone_case,
    create_annotation,
    create_bookmark,
    create_case_from_template,
    create_evidence_attachment,
    link_evidence,
    list_annotations,
    list_bookmarks,
    list_case_activity,
    list_case_templates,
    list_correction_overlays,
    list_evidence_attachments,
    list_source_reliability,
    list_suppression_rules,
    list_validation_errors,
    record_activity,
    record_validation_error,
    reproducibility_manifest,
    resolve_validation_error,
    save_case_template,
    save_suppression_rule,
    set_case_archived,
    set_source_reliability,
)


def _case(case_id="case-1", title="Case One"):
    now = datetime.now(timezone.utc)
    return CaseRecord(id=case_id, title=title, created_at=now, updated_at=now)


def test_case_activity_annotations_bookmarks_and_archive(tmp_path):
    db = tmp_path / "workspace.sqlite3"
    save_case(_case(), db)

    activity = record_activity("case-1", "opened", actor="analyst", path=db)
    assert activity["action"] == "opened"
    assert list_case_activity("case-1", path=db)[0]["actor"] == "analyst"

    annotation = create_annotation(
        "event", "event-1", "Reviewed public-source record.", case_id="case-1", author="analyst",
        disposition="suspicious", list_state="allowlist", path=db,
    )
    assert annotation["disposition"] == "suspicious"
    assert list_annotations(case_id="case-1", disposition="suspicious", path=db)[0]["list_state"] == "allowlist"

    first = create_bookmark("case-1", "event", "event-1", label="review", path=db)
    second = create_bookmark("case-1", "event", "event-1", label="duplicate", path=db)
    assert first["id"] == second["id"]
    assert len(list_bookmarks("case-1", path=db)) == 1

    assert set_case_archived("case-1", True, path=db)["status"] == "archived"
    assert set_case_archived("case-1", False, path=db)["status"] == "open"
    actions = {row["action"] for row in list_case_activity("case-1", path=db)}
    assert {"annotation_added", "bookmark_added", "case_archived", "case_restored"} <= actions


def test_templates_clone_evidence_and_manifest(tmp_path):
    db = tmp_path / "workspace.sqlite3"
    save_case_template("incident", "Incident", priority="high", tags=["public"], notes="Template notes", path=db)
    assert list_case_templates(path=db)[0]["tags"] == ["public"]
    created = create_case_from_template("incident", "case-source", "Source Case", owner="analyst", path=db)
    assert created["priority"] == "high"

    now = datetime.now(timezone.utc)
    event = EventRecord(
        id="event-1", source_id="source-a", source_record_id="1", category="test", title="Observed event",
        observed_at=now,
        evidence=[EvidenceReference(acquisition_id="acq-1", field="title", kind=EvidenceKind.TRANSFORMED, source_path="$.title")],
    )
    save_events([event], db)
    add_case_object("case-source", "event", "event-1", db)

    evidence = create_evidence_attachment(
        "case-source", "Public evidence", source_url="https://example.invalid/public", acquisition_id="acq-1",
        artifact_sha256="a" * 64, mime_type="text/plain", path=db,
    )
    link_evidence(evidence["id"], "event", "event-1", path=db)
    attachments = list_evidence_attachments("case-source", path=db)
    assert attachments[0]["links"][0]["object_id"] == "event-1"

    cloned = clone_case("case-source", "case-branch", "Alternate Hypothesis", note="branch", path=db)
    assert cloned["objects_cloned"] == 1
    assert cloned["evidence_cloned"] == 1

    manifest = reproducibility_manifest("case-source", path=db)
    assert manifest["format"] == "solari-reproducibility-manifest"
    assert manifest["source_ids"] == ["source-a"]
    assert manifest["acquisition_ids"] == ["acq-1"]
    assert manifest["transformations"][0]["kind"] == "transformed"


def test_quality_review_persistence(tmp_path):
    db = tmp_path / "workspace.sqlite3"
    correction = add_correction_overlay(
        "event", "event-1", "title", "Corrected", original_value="Original", reason="Public source correction", author="analyst", path=db,
    )
    assert correction["corrected_value"] == "Corrected"
    stored = list_correction_overlays("event", "event-1", path=db)[0]
    assert stored["original_value"] == "Original"
    assert stored["corrected_value"] == "Corrected"

    error = record_validation_error("source-a", "schema", "missing field", record_ref="row-1", payload={"x": 1}, path=db)
    assert list_validation_errors(source_id="source-a", path=db)[0]["payload"] == {"x": 1}
    resolve_validation_error(error["id"], path=db)
    assert list_validation_errors(source_id="source-a", path=db) == []
    assert len(list_validation_errors(source_id="source-a", unresolved_only=False, path=db)) == 1

    reliability = set_source_reliability("source-a", 0.8, reason="authoritative public source", path=db)
    assert reliability["score"] == 0.8
    assert list_source_reliability(path=db)[0]["source_id"] == "source-a"

    rule = save_suppression_rule("known-benign", "hostname", "example.invalid", "fixture", path=db)
    assert rule["enabled"] is True
    assert list_suppression_rules(enabled_only=True, path=db)[0]["match_type"] == "hostname"
