from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any

from app.solari.sandbox import SandboxExecution, build_json_transform_program, run_python_sync


@dataclass(slots=True)
class TransformationRecord:
    engine: str
    sandbox_id: str
    duration_ms: float
    expression: str
    input_sha256: str | None
    output: Any
    stdout: list[str]
    stderr: list[str]
    error: str | None

    def public_dict(self) -> dict[str, Any]:
        return asdict(self)


def sandbox_transform(payload: dict[str, Any], expression: str, *, input_sha256: str | None = None) -> TransformationRecord:
    """Transform a JSON-compatible acquisition in a disposable Solari sandbox.

    The expression is Python evaluated against a variable named ``data``. This
    is intentionally executed only inside the isolated microVM, never in the
    application process. The caller is responsible for using trusted workflow
    definitions or an explicit review boundary before accepting arbitrary code.
    """
    program = build_json_transform_program(payload, expression)
    execution: SandboxExecution = run_python_sync(program)
    if execution.error:
        output = None
    else:
        candidates = [line.strip() for line in execution.stdout if line.strip()]
        if not candidates:
            output = None
        else:
            try:
                output = json.loads(candidates[-1])
            except json.JSONDecodeError:
                output = candidates[-1]
    return TransformationRecord(
        engine="solari-sandbox-python",
        sandbox_id=execution.sandbox_id,
        duration_ms=execution.duration_ms,
        expression=expression,
        input_sha256=input_sha256,
        output=output,
        stdout=execution.stdout,
        stderr=execution.stderr,
        error=execution.error,
    )
