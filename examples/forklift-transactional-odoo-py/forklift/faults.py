"""Precommittable faults for developmental and sealed trials."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from enum import Enum


class Milestone(str, Enum):
    BEFORE_LOGIN = "before_login"
    PO_DRAFT_SAVED = "po_draft_saved"
    PO_CONFIRMED = "po_confirmed"
    RECEIPT_QUANTITY_ENTERED = "receipt_quantity_entered"
    RECEIPT_VALIDATED = "receipt_validated"
    BILL_DRAFT_CREATED = "bill_draft_created"
    BILL_POSTED = "bill_posted"
    PAYMENT_DIALOG_READY = "payment_dialog_ready"
    PAYMENT_SUBMITTED = "payment_submitted"


class FaultKind(str, Enum):
    NONE = "none"
    KILL_WORKER = "kill_worker"
    KILL_BROWSER = "kill_browser"
    PAUSE_WORKER = "pause_worker"
    DUPLICATE_ACTION = "duplicate_action"
    MUTATE_FIELD = "mutate_field"


@dataclass(frozen=True)
class Fault:
    kind: FaultKind
    milestone: Milestone
    target: str = ""
    replacement: str = ""
    duration_ms: int = 0

    def __post_init__(self) -> None:
        if self.kind == FaultKind.MUTATE_FIELD and (not self.target or not self.replacement):
            raise ValueError("field mutation requires target and replacement")
        if self.kind == FaultKind.PAUSE_WORKER and self.duration_ms <= 0:
            raise ValueError("pause requires a positive duration")


@dataclass(frozen=True)
class FaultSchedule:
    schedule_id: str
    faults: tuple[Fault, ...]

    def canonical_json(self) -> str:
        payload = {"schedule_id": self.schedule_id, "faults": [asdict(fault) for fault in self.faults]}
        return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)

    def digest(self) -> str:
        return hashlib.sha256(self.canonical_json().encode()).hexdigest()


DEVELOPMENT_SCHEDULES = (
    FaultSchedule("clean", ()),
    FaultSchedule("kill-after-po", (Fault(FaultKind.KILL_WORKER, Milestone.PO_CONFIRMED),)),
    FaultSchedule("kill-after-receipt", (Fault(FaultKind.KILL_WORKER, Milestone.RECEIPT_VALIDATED),)),
    FaultSchedule("kill-after-bill", (Fault(FaultKind.KILL_WORKER, Milestone.BILL_POSTED),)),
    FaultSchedule("browser-dies-during-receipt", (Fault(FaultKind.KILL_BROWSER, Milestone.RECEIPT_QUANTITY_ENTERED),)),
    FaultSchedule("duplicate-receipt", (Fault(FaultKind.DUPLICATE_ACTION, Milestone.RECEIPT_QUANTITY_ENTERED, target="validate_receipt"),)),
    FaultSchedule("duplicate-payment", (Fault(FaultKind.DUPLICATE_ACTION, Milestone.PAYMENT_DIALOG_READY, target="submit_payment"),)),
    FaultSchedule("wrong-received-quantity", (Fault(FaultKind.MUTATE_FIELD, Milestone.RECEIPT_QUANTITY_ENTERED, target="received_qty", replacement="ordered_qty"),)),
    FaultSchedule("wrong-unit-price", (Fault(FaultKind.MUTATE_FIELD, Milestone.PO_DRAFT_SAVED, target="unit_price", replacement="unit_price_plus_0.01"),)),
    FaultSchedule("timeout-before-payment", (Fault(FaultKind.PAUSE_WORKER, Milestone.PAYMENT_DIALOG_READY, duration_ms=90_000),)),
)
