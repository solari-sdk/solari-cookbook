from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class NotificationMessage(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=20_000)
    severity: Literal["info", "warning", "critical"] = "info"
    correlation_id: str | None = Field(default=None, max_length=200)
    links: list[str] = Field(default_factory=list, max_length=20)


class ConnectorEnvelope(BaseModel):
    connector: Literal["email", "slack-style"]
    destination_reference: str = Field(min_length=1, max_length=200)
    payload: dict[str, Any]


class NotificationTransport(Protocol):
    def send(self, envelope: ConnectorEnvelope) -> dict[str, object]: ...


def _safe_reference(value: str) -> str:
    clean = value.strip()
    if not clean or any(token in clean.lower() for token in ("token=", "key=", "secret=", "password=", "https://hooks.")):
        raise ValueError("destination reference must be a non-secret configuration identifier")
    return clean


def email_envelope(message: NotificationMessage, *, recipient: str, transport_reference: str = "EMAIL_TRANSPORT") -> ConnectorEnvelope:
    address = recipient.strip()
    if len(address) > 320 or not EMAIL_RE.fullmatch(address):
        raise ValueError("recipient must be a valid email address")
    reference = _safe_reference(transport_reference)
    return ConnectorEnvelope(
        connector="email",
        destination_reference=reference,
        payload={
            "to": address,
            "subject": message.subject,
            "text": message.text,
            "severity": message.severity,
            "correlation_id": message.correlation_id,
            "links": message.links,
        },
    )


def slack_style_envelope(message: NotificationMessage, *, destination_reference: str = "SLACK_DESTINATION") -> ConnectorEnvelope:
    reference = _safe_reference(destination_reference)
    prefix = {"info": "INFO", "warning": "WARNING", "critical": "CRITICAL"}[message.severity]
    text = f"[{prefix}] {message.subject}\n{message.text}"
    if message.links:
        text += "\n" + "\n".join(message.links)
    return ConnectorEnvelope(
        connector="slack-style",
        destination_reference=reference,
        payload={"text": text, "correlation_id": message.correlation_id},
    )


@dataclass(slots=True)
class RecordingTransport:
    """In-memory transport used for demos/tests without external credentials."""

    sent: list[ConnectorEnvelope]

    def send(self, envelope: ConnectorEnvelope) -> dict[str, object]:
        self.sent.append(envelope)
        return {"status": "recorded", "connector": envelope.connector, "destination_reference": envelope.destination_reference}
