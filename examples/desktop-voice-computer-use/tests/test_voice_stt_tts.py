import pytest
from src.voice.stt import VoiceTranscriber
from src.voice.tts import VoiceSynthesizer


def test_stt_initialization_and_fallback():
    stt = VoiceTranscriber(api_key=None)
    # Mock fallback
    text = stt.transcribe_audio_bytes(b"mock_audio_bytes")
    assert isinstance(text, str)
    assert len(text) > 0


def test_tts_initialization_and_data_uri():
    tts = VoiceSynthesizer(api_key=None)
    # When no API key is provided, returns graceful empty / fallback
    uri = tts.synthesize_to_data_uri("Hello world")
    assert isinstance(uri, str)
