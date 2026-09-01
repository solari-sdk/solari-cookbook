from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from typing import Any

from solari_sandbox import SandboxClient

BASE_URL = "https://api.getsolari.com"
MAX_STATEFUL_STEPS = 20


@dataclass(slots=True)
class SandboxExecution:
    sandbox_id: str
    duration_ms: float
    stdout: list[str]
    stderr: list[str]
    results: list[str]
    error: str | None


@dataclass(slots=True)
class StatefulSandboxExecution:
    sandbox_id: str
    duration_ms: float
    steps: list[SandboxExecution]
    error: str | None


def _collect_output(output: Any, sandbox_id: str, duration_ms: float) -> SandboxExecution:
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
        duration_ms=duration_ms,
        stdout=stdout,
        stderr=stderr,
        results=results,
        error=str(output.error) if output.error else None,
    )


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
            step_started = time.perf_counter()
            output = await sandbox.run_code(code, context_id=context_id)
            return _collect_output(output, sandbox_id, (time.perf_counter() - step_started) * 1000.0)
        finally:
            await sandbox.kill()


def run_python_sync(code: str, *, timeout_ms: int = 120_000) -> SandboxExecution:
    return asyncio.run(run_python(code, timeout_ms=timeout_ms))


async def run_python_steps(codes: list[str], *, timeout_ms: int = 120_000) -> StatefulSandboxExecution:
    if not codes or len(codes) > MAX_STATEFUL_STEPS:
        raise ValueError(f"codes must contain between 1 and {MAX_STATEFUL_STEPS} steps")
    if any(not code.strip() for code in codes):
        raise ValueError("stateful sandbox steps must not be empty")
    api_key = os.getenv("SOLARI_API_KEY")
    if not api_key:
        raise RuntimeError("SOLARI_API_KEY is required for live Solari sandbox execution")
    started = time.perf_counter()
    async with SandboxClient(api_key=api_key, base_url=BASE_URL) as client:
        sandbox = await client.create(template="base", timeout_ms=timeout_ms)
        sandbox_id = sandbox.sandboxId
        steps: list[SandboxExecution] = []
        terminal_error: str | None = None
        try:
            await sandbox.connect()
            context_id = await sandbox.create_code_context("python")
            for code in codes:
                step_started = time.perf_counter()
                output = await sandbox.run_code(code, context_id=context_id)
                execution = _collect_output(output, sandbox_id, (time.perf_counter() - step_started) * 1000.0)
                steps.append(execution)
                if execution.error:
                    terminal_error = execution.error
                    break
        finally:
            await sandbox.kill()
    return StatefulSandboxExecution(
        sandbox_id=sandbox_id,
        duration_ms=(time.perf_counter() - started) * 1000.0,
        steps=steps,
        error=terminal_error,
    )


def run_python_steps_sync(codes: list[str], *, timeout_ms: int = 120_000) -> StatefulSandboxExecution:
    return asyncio.run(run_python_steps(codes, timeout_ms=timeout_ms))


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


def build_geospatial_enrichment_program(points: list[dict[str, float]]) -> str:
    if not 2 <= len(points) <= 1000:
        raise ValueError("geospatial enrichment requires 2 to 1000 points")
    normalized = []
    for point in points:
        latitude = float(point["latitude"])
        longitude = float(point["longitude"])
        if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
            raise ValueError("invalid geospatial coordinate")
        normalized.append({"latitude": latitude, "longitude": longitude})
    serialized = json.dumps(normalized, ensure_ascii=False)
    return (
        "import json, math\n"
        f"points = json.loads({serialized!r})\n"
        "def distance_km(a, b):\n"
        "    r=6371.0088\n"
        "    lat1,lon1,lat2,lon2=map(math.radians,[a['latitude'],a['longitude'],b['latitude'],b['longitude']])\n"
        "    dlat=lat2-lat1; dlon=lon2-lon1\n"
        "    h=math.sin(dlat/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2\n"
        "    return 2*r*math.atan2(math.sqrt(h),math.sqrt(max(0.0,1-h)))\n"
        "distances=[distance_km(points[i],points[i+1]) for i in range(len(points)-1)]\n"
        "print(json.dumps({'segment_distances_km':distances,'total_distance_km':sum(distances)},sort_keys=True))\n"
    )
