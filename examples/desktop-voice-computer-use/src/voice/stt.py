import io
import os
import wave
from typing import Optional
from openai import OpenAI
from src.config import settings
from src.utils.logger import logger


class VoiceTranscriber:
    """Handles Speech-to-Text transcription via OpenAI Whisper API."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or settings.openai_api_key
        self.client: Optional[OpenAI] = None
        if self.api_key and not self.api_key.startswith("sk-your"):
            self.client = OpenAI(api_key=self.api_key)

    def transcribe_audio_bytes(self, audio_bytes: bytes, filename: str = "recording.wav") -> str:
        """Transcribes raw audio bytes using OpenAI Whisper."""
        if not self.client:
            logger.warning("[STT] No OpenAI API Key found. Returning mock transcription.")
            return "Search for the current weather in Tokyo and tell me the temperature."

        try:
            audio_buffer = io.BytesIO(audio_bytes)
            audio_buffer.name = filename

            transcript = self.client.audio.transcriptions.create(
                model=settings.whisper_model,
                file=audio_buffer
            )
            text = transcript.text.strip()
            logger.info(f"[STT] Transcribed: \"{text}\"")
            return text
        except Exception as e:
            logger.error(f"[STT] Whisper transcription failed: {e}")
            raise

    def transcribe_file(self, file_path: str) -> str:
        """Transcribes an audio file on disk."""
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Audio file not found: {file_path}")

        with open(file_path, "rb") as f:
            return self.transcribe_audio_bytes(f.read(), filename=os.path.basename(file_path))

    def record_microphone(self, duration_seconds: int = 5, sample_rate: int = 16000) -> Optional[bytes]:
        """
        Records audio from the local microphone if sounddevice or pyaudio is available.
        Returns WAV audio bytes, or None if no recording hardware/library is present.
        """
        try:
            import sounddevice as sd
            import numpy as np

            logger.info(f"[STT] 🎙️ Recording from microphone for {duration_seconds} seconds... (Speak now)")
            recording = sd.rec(
                int(duration_seconds * sample_rate),
                samplerate=sample_rate,
                channels=1,
                dtype="int16"
            )
            sd.wait()
            logger.info("[STT] ⏹️ Recording finished.")

            # Convert numpy array to WAV bytes
            byte_io = io.BytesIO()
            with wave.open(byte_io, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)  # 16-bit
                wf.setframerate(sample_rate)
                wf.writeframes(recording.tobytes())

            return byte_io.getvalue()
        except ImportError:
            logger.info("[STT] sounddevice is not installed. You can record directly via the War Room Web UI or enter text.")
            return None
        except Exception as e:
            logger.warning(f"[STT] Microphone capture failed: {e}")
            return None
