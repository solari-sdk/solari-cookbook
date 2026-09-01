import pytest

from app.notification_connectors import NotificationMessage, RecordingTransport, email_envelope, slack_style_envelope


def test_email_and_slack_style_envelopes_keep_credentials_out_of_contracts():
    message = NotificationMessage(subject="Source stale", text="A public source has not refreshed.", severity="warning", correlation_id="corr-1")
    email = email_envelope(message, recipient="analyst@example.org")
    slack = slack_style_envelope(message)
    assert email.destination_reference == "EMAIL_TRANSPORT"
    assert email.payload["to"] == "analyst@example.org"
    assert slack.destination_reference == "SLACK_DESTINATION"
    assert "WARNING" in slack.payload["text"]


def test_secret_bearing_destination_references_are_rejected():
    message = NotificationMessage(subject="Test", text="Test")
    with pytest.raises(ValueError):
        slack_style_envelope(message, destination_reference="https://hooks.example.invalid/secret")
    with pytest.raises(ValueError):
        email_envelope(message, recipient="bad-address")


def test_recording_transport_is_side_effect_free():
    message = NotificationMessage(subject="Demo", text="Local only")
    envelope = slack_style_envelope(message)
    transport = RecordingTransport(sent=[])
    result = transport.send(envelope)
    assert result["status"] == "recorded"
    assert transport.sent == [envelope]
