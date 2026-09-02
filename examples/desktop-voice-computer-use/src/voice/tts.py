import io
import os
import base64
from typing import Optional
from openai import OpenAI
from src.config import settings
from src.utils.logger import logger


class VoiceSynthesizer:
    """Handles Text-to-Speech generation via OpenAI Audio Speech API."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or settings.openai_api_key
        self.client: Optional[OpenAI] = None
        if self.api_key and not self.api_key.startswith("sk-your"):
            self.client = OpenAI(api_key=self.api_key)

    def synthesize_to_bytes(
        self,
        text: str,
        voice: Optional[str] = None,
        response_format: str = "mp3"
    ) -> bytes:
        """
        Synthesizes text into audio bytes.
        """
        voice = voice or settings.tts_voice
        if not self.client:
            logger.warning("[TTS] No OpenAI API Key found. Returning empty audio bytes.")
            return b""

        try:
            logger.info(f"[TTS] 🔊 Generating speech: \"{text[:80]}...\" (Voice: {voice})")
            response = self.client.audio.speech.create(
                model=settings.tts_model,
                voice=voice,
                input=text,
                response_format=response_format
            )
            audio_bytes = response.content
            return audio_bytes
        except Exception as e:
            logger.error(f"[TTS] Speech synthesis failed: {e}")
            return b""

    def synthesize_to_data_uri(self, text: str) -> str:
        """Synthesizes text and returns an HTML5 audio data URI for War Room dashboard streaming."""
        audio_bytes = self.synthesize_to_bytes(text, response_format="mp3")
        if not audio_bytes:
            return ""
        b64 = base64.b64encode(audio_bytes).decode("utf-8")
        return f"data:audio/mp3;base64,{b64}"

    def synthesize_and_save(self, text: str, output_path: str) -> str:
        """Synthesizes speech and writes to a file."""
        audio_bytes = self.synthesize_to_bytes(text)
        if audio_bytes:
            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
            with open(output_path, "wb") as f:
                f.write(audio_bytes)
            logger.info(f"[TTS] Audio saved to {output_path}")
            return output_path
        return ""

    def play_locally(self, audio_bytes: bytes) -> None:
        """Attempts to play synthesized audio on local speakers."""
        if not audio_bytes:
            return

        try:
            # Temporary save and play
            temp_path = os.path.join(os.getcwd(), "temp_speech.mp3")
            with open(temp_path, "wb") as f:
                f.write(audio_bytes)

            if os.name == "nt":  # Windows
                # Use Windows MediaPlayer command or powershell
                import subprocess
                subprocess.Popen(
                    ["powershell", "-c", f"(New-Object Media.SoundPlayer '{temp_path}').PlaySync();"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
            else:
                import subprocess
                subprocess.Popen(["afplay" if os.uname().sysname == "Darwin" else "aplay", temp_path])
        except Exception as e:
            logger.debug(f"[TTS] Local audio playback skipped: {e}")
