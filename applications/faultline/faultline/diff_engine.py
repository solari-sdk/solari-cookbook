"""State Diff Engine for Fault Line."""

from __future__ import annotations

from typing import Any

from .models import FieldChange, RecordDiff, StateDiff
from .workload import CRMWorkloadStore


class StateDiffEngine:
    """Computes field-level differences between two datastore states."""

    @staticmethod
    def compare_stores(
        from_checkpoint_id: str,
        to_checkpoint_id: str,
        before_store: CRMWorkloadStore,
        after_store: CRMWorkloadStore,
    ) -> StateDiff:
        created: list[RecordDiff] = []
        deleted: list[RecordDiff] = []
        changed: list[RecordDiff] = []

        # 1. Compare Leads
        before_leads = {l.id: l.to_dict() for l in before_store.get_all_leads()}
        after_leads = {l.id: l.to_dict() for l in after_store.get_all_leads()}

        # Created Leads
        for lead_id, lead_dict in after_leads.items():
            if lead_id not in before_leads:
                created.append(
                    RecordDiff(record_type="Lead", record_id=lead_id, change_type="created")
                )

        # Deleted Leads
        for lead_id in before_leads:
            if lead_id not in after_leads:
                deleted.append(
                    RecordDiff(record_type="Lead", record_id=lead_id, change_type="deleted")
                )

        # Changed Leads
        for lead_id, old_dict in before_leads.items():
            if lead_id in after_leads:
                new_dict = after_leads[lead_id]
                field_changes = []
                for k, old_val in old_dict.items():
                    if k in new_dict and new_dict[k] != old_val:
                        field_changes.append(
                            FieldChange(field_name=k, old_value=old_val, new_value=new_dict[k])
                        )
                if field_changes:
                    changed.append(
                        RecordDiff(
                            record_type="Lead",
                            record_id=lead_id,
                            change_type="changed",
                            field_changes=field_changes,
                        )
                    )

        # 2. Compare OutboundMessages
        before_msgs = {m.id: m.to_dict() for m in before_store.get_all_outbound_messages()}
        after_msgs = {m.id: m.to_dict() for m in after_store.get_all_outbound_messages()}

        # Created Messages
        for msg_id in after_msgs:
            if msg_id not in before_msgs:
                created.append(
                    RecordDiff(
                        record_type="OutboundMessage",
                        record_id=msg_id,
                        change_type="created",
                    )
                )

        # Deleted Messages
        for msg_id in before_msgs:
            if msg_id not in after_msgs:
                deleted.append(
                    RecordDiff(
                        record_type="OutboundMessage",
                        record_id=msg_id,
                        change_type="deleted",
                    )
                )

        # Changed Messages
        for msg_id, old_dict in before_msgs.items():
            if msg_id in after_msgs:
                new_dict = after_msgs[msg_id]
                field_changes = []
                for k, old_val in old_dict.items():
                    if k in new_dict and new_dict[k] != old_val:
                        field_changes.append(
                            FieldChange(field_name=k, old_value=old_val, new_value=new_dict[k])
                        )
                if field_changes:
                    changed.append(
                        RecordDiff(
                            record_type="OutboundMessage",
                            record_id=msg_id,
                            change_type="changed",
                            field_changes=field_changes,
                        )
                    )

        return StateDiff(
            from_checkpoint_id=from_checkpoint_id,
            to_checkpoint_id=to_checkpoint_id,
            created_records=created,
            deleted_records=deleted,
            changed_records=changed,
        )
