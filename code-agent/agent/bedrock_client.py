"""Thin wrapper around AWS Bedrock's Converse API.

Bedrock's Converse API is a normalized interface across model providers
(Anthropic, Mistral, Cohere, Amazon...). This project targets the Mistral
family specifically - verified live against the account's actual Bedrock
access (see qa-agent/README.md): tool calling works on
mistral.mistral-large-3-675b-instruct; vision support varies by model and
is checked at startup, not assumed.

boto3 is sync-only, so every call is offloaded to a thread to keep the
orchestrator's asyncio loop non-blocking.
"""

from __future__ import annotations

import asyncio
from typing import Any

import boto3
from botocore.config import Config


class BedrockClient:
    def __init__(self, model_id: str, region: str):
        self.model_id = model_id
        session = boto3.Session(region_name=region)
        # Default botocore read_timeout is 60s, too short for a 675B model's
        # first token on a cold Bedrock endpoint - raise it.
        self._client = session.client(
            "bedrock-runtime",
            config=Config(read_timeout=180, connect_timeout=10, retries={"max_attempts": 2}),
        )

    async def converse(
        self,
        *,
        system: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        max_tokens: int = 2048,
    ) -> dict:
        kwargs: dict[str, Any] = {
            "modelId": self.model_id,
            "system": [{"text": system}],
            "messages": messages,
            "inferenceConfig": {"maxTokens": max_tokens},
        }
        if tools:
            kwargs["toolConfig"] = {"tools": [{"toolSpec": t} for t in tools]}
        return await asyncio.to_thread(self._client.converse, **kwargs)
