import os
from typing import Optional
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from dotenv import load_dotenv

load_dotenv()


class Settings(BaseSettings):
    """Global configuration settings for Solari Voice Agent."""
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

    # Solari Cloud API Keys & Endpoint
    solari_api_key: str = Field(
        default_factory=lambda: os.getenv("SOLARI_API_KEY", "")
    )
    solari_api_base: str = Field(
        default_factory=lambda: os.getenv("SOLARI_API_BASE", "https://api.getsolari.com")
    )

    # OpenAI API Key & Models
    openai_api_key: str = Field(
        default_factory=lambda: os.getenv("OPENAI_API_KEY", "")
    )
    vision_model: str = Field(
        default_factory=lambda: os.getenv("VISION_MODEL", "gpt-4o")
    )
    planning_model: str = Field(
        default_factory=lambda: os.getenv("PLANNING_MODEL", "gpt-4o")
    )
    whisper_model: str = Field(
        default_factory=lambda: os.getenv("WHISPER_MODEL", "whisper-1")
    )
    tts_model: str = Field(
        default_factory=lambda: os.getenv("TTS_MODEL", "tts-1")
    )
    tts_voice: str = Field(
        default_factory=lambda: os.getenv("TTS_VOICE", "alloy")
    )

    # Solari Desktop VM Settings
    desktop_width: int = Field(
        default_factory=lambda: int(os.getenv("DESKTOP_WIDTH", "1024"))
    )
    desktop_height: int = Field(
        default_factory=lambda: int(os.getenv("DESKTOP_HEIGHT", "768"))
    )
    desktop_timeout: int = Field(
        default_factory=lambda: int(os.getenv("DESKTOP_TIMEOUT", "600"))
    )
    desktop_on_timeout: str = Field(
        default_factory=lambda: os.getenv("DESKTOP_ON_TIMEOUT", "kill")
    )

    # Execution limits
    max_steps: int = Field(
        default_factory=lambda: int(os.getenv("MAX_STEPS", "15"))
    )

    # Observability Server & War Room Dashboard
    server_host: str = Field(
        default_factory=lambda: os.getenv("SERVER_HOST", "127.0.0.1")
    )
    server_port: int = Field(
        default_factory=lambda: int(os.getenv("SERVER_PORT", "8000"))
    )

    # Mock / Emulation Mode
    use_mock_desktop: bool = Field(
        default_factory=lambda: os.getenv("USE_MOCK_DESKTOP", "false").lower() in ("true", "1", "yes")
    )


# Singleton settings instance
settings = Settings()
