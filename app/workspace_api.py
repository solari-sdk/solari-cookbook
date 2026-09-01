from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, HttpUrl

from app.contracts import EntityRecord, GeoPoint, RelationshipRecord, stable_id
from app.storage import save_entities, save_relationships
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

router = APIRouter(prefix="/api/v1", tags=["workspace"])


class ActivityInput(BaseModel):
    action: str = Field(min_length=1, max_length=100)
    actor: str | None = Field(default=None, max_length=120)
    object_type: str | None = Field(default=None, max_length=40)
    object_id: str | None = Field(default=None, max_length=256)
    note: str | None = Field(default=None, max_length=4000)


class AnnotationInput(BaseModel):
    object_type: str = Field(min_length=1, max_length=40)
    object_id: str = Field(min_length=1, max_length=256)
    body: str = Field(min_length=1, max_length=10000)
    case_id: str | None = Field(default=None, max_length=256)
    author: str | None = Field(default=None, max_length=120)
    disposition: Literal["unreviewed", "true_positive", "false_positive", "suspicious"] = "unreviewed"
    list_state: Literal["none", "allowlist", "blocklist"] = "none"


class BookmarkInput(BaseModel):
    object_type: str = Field(min_length=1, max_length=40)
    object_id: str = Field(min_length=1, max_length=256)
    label: str | None = Field(default=None, max_length=500)


class TemplateInput(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=200)
    status: Literal["open", "paused", "closed", "archived"] = "open"
    priority: Literal["low", "normal", "high", "critical"] = "normal"
    tags: list[str] = Field(default_factory=list, max_length=100)
    notes: str = Field(default="", max_length=50000)


class TemplateCaseInput(BaseModel):
    case_id: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=500)
    owner: str | None = Field(default=None, max_length=120)


class CloneCaseInput(BaseModel):
    case_id: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=500)
    owner: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=4000)


class ArchiveInput(BaseModel):
    archived: bool = True
    actor: str | None = Field(default=None, max_length=120)


class EvidenceInput(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    source_url: HttpUrl | None = None
    acquisition_id: str | None = Field(default=None, max_length=256)
    artifact_sha256: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{64}$")
    mime_type: str | None = Field(default=None, max_length=200)
    note: str | None = Field(default=None, max_length=10000)


class EvidenceLinkInput(BaseModel):
    object_type: Literal["event", "entity", "relationship"]
    object_id: str = Field(min_length=1, max_length=256)


class CorrectionInput(BaseModel):
    object_type: str = Field(min_length=1, max_length=40)
    object_id: str = Field(min_length=1, max_length=256)
    field: str = Field(min_length=1, max_length=200)
    original_value: Any = None
    corrected_value: Any
    reason: str = Field(min_length=1, max_length=4000)
    author: str | None = Field(default=None, max_length=120)


class ValidationErrorInput(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)
    error_type: str = Field(min_length=1, max_length=120)
    error_message: str = Field(min_length=1, max_length=4000)
    acquisition_id: str | None = Field(default=None, max_length=256)
    record_ref: str | None = Field(default=None, max_length=500)
    payload: Any = None


class ReliabilityInput(BaseModel):
    score: float = Field(ge=0.0, le=1.0)
    reason: str | None = Field(default=None, max_length=4000)


class SuppressionInput(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    match_type: Literal["exact", "substring", "hostname", "cidr", "regex"]
    pattern: str = Field(min_length=1, max_length=1000)
    reason: str = Field(min_length=1, max_length=4000)
    enabled: bool = True


class ManualEntityInput(BaseModel):
    label: str = Field(min_length=1, max_length=500)
    type: Literal[
        "location", "organization", "infrastructure", "domain", "ip", "url", "email",
        "username", "phone", "vessel", "aircraft", "satellite", "event", "source", "other"
    ]
    aliases: list[str] = Field(default_factory=list, max_length=100)
    location: GeoPoint | None = None
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    properties: dict[str, Any] = Field(default_factory=dict)


class ManualRelationshipInput(BaseModel):
    source_entity_id: str = Field(min_length=1, max_length=256)
    target_entity_id: str = Field(min_length=1, max_length=256)
    type: str = Field(min_length=1, max_length=120)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    observed: bool = True
    properties: dict[str, Any] = Field(default_factory=dict)


def _translate(exc: Exception) -> HTTPException:
    if isinstance(exc, KeyError):
        return HTTPException(404, str(exc).strip("'"))
    if isinstance(exc, ValueError):
        return HTTPException(400, str(exc))
    return HTTPException(500, type(exc).__name__)


@router.get("/cases/{case_id}/activity")
def case_activity(case_id: str, limit: int = Query(500, ge=1, le=1000)) -> list[dict[str, object]]:
    try: return list_case_activity(case_id, limit)
    except Exception as exc: raise _translate(exc) from exc


@router.post("/cases/{case_id}/activity")
def add_case_activity(case_id: str, body: ActivityInput) -> dict[str, object]:
    try: return record_activity(case_id, body.action, actor=body.actor, object_type=body.object_type, object_id=body.object_id, note=body.note)
    except Exception as exc: raise _translate(exc) from exc


@router.get("/annotations")
def annotations(object_type: str | None = None, object_id: str | None = None, case_id: str | None = None, disposition: str | None = None, list_state: str | None = None, limit: int = Query(500, ge=1, le=1000)) -> list[dict[str, object]]:
    return list_annotations(object_type=object_type, object_id=object_id, case_id=case_id, disposition=disposition, list_state=list_state, limit=limit)


@router.post("/annotations")
def add_annotation(body: AnnotationInput) -> dict[str, object]:
    try: return create_annotation(body.object_type, body.object_id, body.body, case_id=body.case_id, author=body.author, disposition=body.disposition, list_state=body.list_state)
    except Exception as exc: raise _translate(exc) from exc


@router.get("/cases/{case_id}/bookmarks")
def bookmarks(case_id: str) -> list[dict[str, object]]:
    try: return list_bookmarks(case_id)
    except Exception as exc: raise _translate(exc) from exc


@router.post("/cases/{case_id}/bookmarks")
def add_bookmark(case_id: str, body: BookmarkInput) -> dict[str, object]:
    try: return create_bookmark(case_id, body.object_type, body.object_id, label=body.label)
    except Exception as exc: raise _translate(exc) from exc


@router.get("/case-templates")
def case_templates() -> list[dict[str, object]]: return list_case_templates()


@router.post("/case-templates")
def put_case_template(body: TemplateInput) -> dict[str, object]:
    try: return save_case_template(body.id, body.name, status=body.status, priority=body.priority, tags=body.tags, notes=body.notes)
    except Exception as exc: raise _translate(exc) from exc


@router.post("/case-templates/{template_id}/instantiate")
def instantiate_case(template_id: str, body: TemplateCaseInput) -> dict[str, object]:
    try: return create_case_from_template(template_id, body.case_id, body.title, owner=body.owner)
    except Exception as exc: raise _translate(exc) from exc


@router.post("/cases/{case_id}/clone")
def clone(case_id: str, body: CloneCaseInput) -> dict[str, object]:
    try: return clone_case(case_id, body.case_id, body.title, owner=body.owner, note=body.note)
    except Exception as exc: raise _translate(exc) from exc


@router.post("/cases/{case_id}/archive")
def archive(case_id: str, body: ArchiveInput) -> dict[str, object]:
    try: return set_case_archived(case_id, body.archived, actor=body.actor)
    except Exception as exc: raise _translate(exc) from exc


@router.get("/cases/{case_id}/evidence-attachments")
def evidence_attachments(case_id: str) -> list[dict[str, object]]:
    try: return list_evidence_attachments(case_id)
    except Exception as exc: raise _translate(exc) from exc


@router.post("/cases/{case_id}/evidence-attachments")
def add_evidence_attachment(case_id: str, body: EvidenceInput) -> dict[str, object]:
    try:
        return create_evidence_attachment(case_id, body.title, source_url=str(body.source_url) if body.source_url else None, acquisition_id=body.acquisition_id, artifact_sha256=body.artifact_sha256.lower() if body.artifact_sha256 else None, mime_type=body.mime_type, note=body.note)
    except Exception as exc: raise _translate(exc) from exc


@router.post("/evidence-attachments/{evidence_id}/links")
def add_evidence_link(evidence_id: str, body: EvidenceLinkInput) -> dict[str, object]:
    try: return link_evidence(evidence_id, body.object_type, body.object_id)
    except Exception as exc: raise _translate(exc) from exc


@router.get("/cases/{case_id}/reproducibility-manifest")
def manifest(case_id: str) -> dict[str, object]:
    try: return reproducibility_manifest(case_id)
    except Exception as exc: raise _translate(exc) from exc


@router.get("/corrections/{object_type}/{object_id}")
def corrections(object_type: str, object_id: str) -> list[dict[str, object]]: return list_correction_overlays(object_type, object_id)


@router.post("/corrections")
def add_correction(body: CorrectionInput) -> dict[str, object]:
    try: return add_correction_overlay(body.object_type, body.object_id, body.field, body.corrected_value, original_value=body.original_value, reason=body.reason, author=body.author)
    except Exception as exc: raise _translate(exc) from exc


@router.get("/validation-errors")
def validation_errors(source_id: str | None = None, unresolved_only: bool = True, limit: int = Query(500, ge=1, le=1000)) -> list[dict[str, object]]: return list_validation_errors(source_id=source_id, unresolved_only=unresolved_only, limit=limit)


@router.post("/validation-errors")
def add_validation_error(body: ValidationErrorInput) -> dict[str, object]:
    return record_validation_error(body.source_id, body.error_type, body.error_message, acquisition_id=body.acquisition_id, record_ref=body.record_ref, payload=body.payload)


@router.post("/validation-errors/{error_id}/resolve")
def mark_validation_error_resolved(error_id: str) -> dict[str, object]:
    try: return resolve_validation_error(error_id)
    except Exception as exc: raise _translate(exc) from exc


@router.get("/source-reliability")
def source_reliability() -> list[dict[str, object]]: return list_source_reliability()


@router.put("/source-reliability/{source_id}")
def put_source_reliability(source_id: str, body: ReliabilityInput) -> dict[str, object]:
    try: return set_source_reliability(source_id, body.score, reason=body.reason)
    except Exception as exc: raise _translate(exc) from exc


@router.get("/suppression-rules")
def suppression_rules(enabled_only: bool = False) -> list[dict[str, object]]: return list_suppression_rules(enabled_only=enabled_only)


@router.put("/suppression-rules/{rule_id}")
def put_suppression_rule(rule_id: str, body: SuppressionInput) -> dict[str, object]:
    if rule_id != body.id: raise HTTPException(400, "path rule_id must equal body id")
    try: return save_suppression_rule(body.id, body.match_type, body.pattern, body.reason, enabled=body.enabled)
    except Exception as exc: raise _translate(exc) from exc


@router.post("/entities/manual")
def manual_entity(body: ManualEntityInput) -> dict[str, object]:
    now=datetime.now(timezone.utc)
    entity=EntityRecord(id=stable_id("manual-entity", body.type, body.label, now.isoformat()), type=body.type, label=body.label, aliases=body.aliases, first_seen=now, last_seen=now, location=body.location, confidence=body.confidence, properties={**body.properties, "origin":"manual"})
    save_entities([entity]); return entity.model_dump(mode="json")


@router.post("/relationships/manual")
def manual_relationship(body: ManualRelationshipInput) -> dict[str, object]:
    now=datetime.now(timezone.utc)
    relationship=RelationshipRecord(id=stable_id("manual-relationship", body.source_entity_id, body.type, body.target_entity_id, now.isoformat()), source_entity_id=body.source_entity_id, target_entity_id=body.target_entity_id, type=body.type, first_seen=now, last_seen=now, confidence=body.confidence, observed=body.observed, properties={**body.properties, "origin":"manual"})
    save_relationships([relationship]); return relationship.model_dump(mode="json")
