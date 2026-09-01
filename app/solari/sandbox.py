from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from typing import Any

from solari_sandbox import SandboxClient

BASE_URL = "https://api.getsolari.com"


@dataclass(slots=True)
class SandboxExecution:
    sandbox_id: str
    duration_ms: float
    stdout: list[str]
    stderr: list[str]
    results: list[str]
    error: str | None


async def run_python(code: str, *, timeout_ms: int = 120_000) -> SandboxExecution:
    api_key = os.getenv("SOLARI_API_KEY")
    if not api_key:
        raise RuntimeError("SOLARI_API_KEY is required for live Solari sandbox execution")
    if not code.strip():
        raise ValueError("code must not be empty")

    started = time.perf_counter()
    async with SandboxClient(api_key=api_key, base_url=BASE_URL) as client:
        sandbox = await client.create(template="base", timeout_ms=timeout_ms)
        sandbox_id = sandbox.sandboxId
        try:
            await sandbox.connect()
            context_id = await sandbox.create_code_context("python")
            output = await sandbox.run_code(code, context_id=context_id)
            stdout: list[str] = []
            stderr: list[str] = []
            results: list[str] = []
            for item in output.results:
                text = getattr(item, "text", None)
                if not text:
                    continue
                kind = getattr(item, "type", "result")
                if kind == "stdout":
                    stdout.append(text)
                elif kind == "stderr":
                    stderr.append(text)
                else:
                    results.append(text)
            return SandboxExecution(
                sandbox_id=sandbox_id,
                duration_ms=(time.perf_counter() - started) * 1000.0,
                stdout=stdout,
                stderr=stderr,
                results=results,
                error=str(output.error) if output.error else None,
            )
        finally:
            await sandbox.kill()


def run_python_sync(code: str, *, timeout_ms: int = 120_000) -> SandboxExecution:
    return asyncio.run(run_python(code, timeout_ms=timeout_ms))


def build_json_transform_program(payload: dict[str, Any], expression: str) -> str:
    if not expression.strip():
        raise ValueError("expression must not be empty")
    serialized = json.dumps(payload, ensure_ascii=False)
    return (
        "import json\n"
        f"data = json.loads({serialized!r})\n"
        f"result = ({expression})\n"
        "print(json.dumps(result, ensure_ascii=False, sort_keys=True))\n"
    )
