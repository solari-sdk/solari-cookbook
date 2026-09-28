"""Deterministic CRM/GTM Workload Engine for Fault Line."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any

from .models import Lead, OutboundMessage


class CRMWorkloadStore:
    """SQLite-backed deterministic CRM datastore."""

    def __init__(self, db_path: str = ":memory:"):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self.conn:
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS leads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL,
                    company TEXT NOT NULL,
                    owner TEXT NOT NULL,
                    status TEXT NOT NULL
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS outbound_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    lead_id INTEGER NOT NULL,
                    recipient TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    body TEXT NOT NULL,
                    status TEXT NOT NULL,
                    FOREIGN KEY (lead_id) REFERENCES leads (id)
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    step_number INTEGER NOT NULL,
                    action_name TEXT NOT NULL,
                    details TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

    def close(self) -> None:
        self.conn.close()

    def create_lead(
        self, name: str, email: str, company: str, owner: str, status: str
    ) -> Lead:
        with self.conn:
            cursor = self.conn.execute(
                "INSERT INTO leads (name, email, company, owner, status) VALUES (?, ?, ?, ?, ?)",
                (name, email, company, owner, status),
            )
            lead_id = cursor.lastrowid
        return self.get_lead(lead_id)

    def update_lead(self, lead_id: int, **kwargs: Any) -> Lead:
        if not kwargs:
            return self.get_lead(lead_id)
        fields = ", ".join(f"{k} = ?" for k in kwargs.keys())
        values = list(kwargs.values()) + [lead_id]
        with self.conn:
            self.conn.execute(f"UPDATE leads SET {fields} WHERE id = ?", values)
        return self.get_lead(lead_id)

    def assign_owner(self, lead_id: int, owner: str) -> Lead:
        return self.update_lead(lead_id, owner=owner)

    def change_status(self, lead_id: int, status: str) -> Lead:
        return self.update_lead(lead_id, status=status)

    def normalize_company(self, lead_id: int) -> Lead:
        lead = self.get_lead(lead_id)
        normalized = lead.company.strip().title()
        return self.update_lead(lead_id, company=normalized)

    def validate_email(self, lead_id: int) -> Lead:
        lead = self.get_lead(lead_id)
        clean_email = lead.email.strip().lower()
        return self.update_lead(lead_id, email=clean_email)

    def create_outbound_message(
        self, lead_id: int, recipient: str, subject: str, body: str, status: str = "draft"
    ) -> OutboundMessage:
        with self.conn:
            cursor = self.conn.execute(
                """
                INSERT INTO outbound_messages (lead_id, recipient, subject, body, status)
                VALUES (?, ?, ?, ?, ?)
                """,
                (lead_id, recipient, subject, body, status),
            )
            msg_id = cursor.lastrowid
        return self.get_outbound_message(msg_id)

    def send_message(self, message_id: int) -> OutboundMessage:
        with self.conn:
            self.conn.execute(
                "UPDATE outbound_messages SET status = ? WHERE id = ?",
                ("sent", message_id),
            )
        return self.get_outbound_message(message_id)

    def get_lead(self, lead_id: int) -> Lead:
        cursor = self.conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,))
        row = cursor.fetchone()
        if not row:
            raise KeyError(f"Lead with id {lead_id} not found")
        return Lead(
            id=row["id"],
            name=row["name"],
            email=row["email"],
            company=row["company"],
            owner=row["owner"],
            status=row["status"],
        )

    def get_outbound_message(self, message_id: int) -> OutboundMessage:
        cursor = self.conn.execute(
            "SELECT * FROM outbound_messages WHERE id = ?", (message_id,)
        )
        row = cursor.fetchone()
        if not row:
            raise KeyError(f"OutboundMessage with id {message_id} not found")
        return OutboundMessage(
            id=row["id"],
            lead_id=row["lead_id"],
            recipient=row["recipient"],
            subject=row["subject"],
            body=row["body"],
            status=row["status"],
        )

    def get_all_leads(self) -> list[Lead]:
        cursor = self.conn.execute("SELECT * FROM leads ORDER BY id ASC")
        return [
            Lead(
                id=r["id"],
                name=r["name"],
                email=r["email"],
                company=r["company"],
                owner=r["owner"],
                status=r["status"],
            )
            for r in cursor.fetchall()
        ]

    def get_all_outbound_messages(self) -> list[OutboundMessage]:
        cursor = self.conn.execute("SELECT * FROM outbound_messages ORDER BY id ASC")
        return [
            OutboundMessage(
                id=r["id"],
                lead_id=r["lead_id"],
                recipient=r["recipient"],
                subject=r["subject"],
                body=r["body"],
                status=r["status"],
            )
            for r in cursor.fetchall()
        ]

    def dump_canonical_state(self) -> dict[str, Any]:
        """Returns deterministic, key-sorted dictionary representation of DB state."""
        leads = [l.to_dict() for l in self.get_all_leads()]
        messages = [m.to_dict() for m in self.get_all_outbound_messages()]
        return {"leads": leads, "outbound_messages": messages}

    def compute_state_digest(self) -> str:
        """Computes SHA-256 state digest from canonical JSON representation."""
        state = self.dump_canonical_state()
        state_bytes = json.dumps(state, sort_keys=True).encode("utf-8")
        return hashlib.sha256(state_bytes).hexdigest()

    def clone_to_memory(self) -> CRMWorkloadStore:
        """Creates an independent copy of this store in memory."""
        new_store = CRMWorkloadStore(":memory:")
        self.conn.backup(new_store.conn)
        return new_store


def get_default_workflow_steps() -> list[dict[str, Any]]:
    """Returns standard 24-step CRM workflow specification."""
    return [
        # Step 1-5: Create initial leads
        {"action": "create_lead", "args": {"name": "Acme Corp Lead", "email": "contact@acme.com", "company": "  acme corp  ", "owner": "Unassigned", "status": "new"}},
        {"action": "create_lead", "args": {"name": "Stark Industries Lead", "email": "tony@stark.com", "company": "stark inc", "owner": "Unassigned", "status": "new"}},
        {"action": "create_lead", "args": {"name": "Cyberdyne Systems Lead", "email": "sarah@cyberdyne.io", "company": "cyberdyne  ", "owner": "Unassigned", "status": "new"}},
        {"action": "create_lead", "args": {"name": "Wayne Enterprises Lead", "email": "bruce@wayne.org", "company": "WAYNE ENT", "owner": "Unassigned", "status": "new"}},
        {"action": "create_lead", "args": {"name": "Sartorial Tech Lead", "email": "info@sartorial.co", "company": "Sartorial", "owner": "Unassigned", "status": "new"}},

        # Step 6-10: Normalize companies
        {"action": "normalize_company", "args": {"lead_id": 1}},
        {"action": "normalize_company", "args": {"lead_id": 2}},
        {"action": "normalize_company", "args": {"lead_id": 3}},
        {"action": "normalize_company", "args": {"lead_id": 4}},
        {"action": "normalize_company", "args": {"lead_id": 5}},

        # Step 11-15: Assign owner Alice & validate emails
        {"action": "assign_owner", "args": {"lead_id": 1, "owner": "Alice"}},
        {"action": "assign_owner", "args": {"lead_id": 2, "owner": "Alice"}},
        {"action": "assign_owner", "args": {"lead_id": 3, "owner": "Alice"}},
        {"action": "validate_email", "args": {"lead_id": 1}},
        {"action": "validate_email", "args": {"lead_id": 2}},

        # Step 16-18: Qualify leads
        {"action": "change_status", "args": {"lead_id": 1, "status": "qualified"}},
        {"action": "assign_owner", "args": {"lead_id": 1, "owner": "Alice"}},  # Target Step 17 (lead 1 owner assignment/update)
        {"action": "change_status", "args": {"lead_id": 2, "status": "qualified"}},

        # Step 19-21: Outbound message drafting
        {"action": "create_outbound_message", "args": {"lead_id": 1, "recipient": "contact@acme.com", "subject": "Partnership Proposal", "body": "Hello Acme, let us discuss."}},
        {"action": "create_outbound_message", "args": {"lead_id": 2, "recipient": "tony@stark.com", "subject": "Tech Sync", "body": "Hi Tony, demo ready."}},
        {"action": "create_outbound_message", "args": {"lead_id": 3, "recipient": "sarah@cyberdyne.io", "subject": "Intro Call", "body": "Greetings Sarah."}},

        # Step 22-24: Send outbound messages
        {"action": "send_message", "args": {"message_id": 1}},
        {"action": "send_message", "args": {"message_id": 2}},
        {"action": "send_message", "args": {"message_id": 3}},
    ]
