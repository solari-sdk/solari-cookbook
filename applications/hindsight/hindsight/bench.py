"""Benchmark harness: run each arm repeatedly and summarise honestly."""

from __future__ import annotations

import json
import statistics
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from hindsight.agent import Agent, system_for
from hindsight.cost import estimate_cost
from hindsight.sandbox import SolariRunner
from hindsight.session import Session
from hindsight.tasks import Task
from hindsight.tools import tools_for


@dataclass(frozen=True)
class RunResult:
    task: str
    arm: str
    solved: bool
    turns: int
    tool_calls: int
    input_tokens: int
    output_tokens: int
    cost: float
    rewinds: int
    seconds: float
    error: str | None


@dataclass(frozen=True)
class ArmSummary:
    arm: str
    n: int
    solved: int
    success_rate: float
    median_turns: float
    median_tool_calls: float
    median_cost: float
    min_cost: float
    max_cost: float
    median_seconds: float
    total_rewinds: int


def summarise(runs: list[RunResult]) -> dict[str, ArmSummary]:
    """Group runs by arm. Medians and spread, never a single best-case number."""
    by_arm: dict[str, list[RunResult]] = {}
    for run in runs:
        by_arm.setdefault(run.arm, []).append(run)

    summaries: dict[str, ArmSummary] = {}
    for arm, arm_runs in by_arm.items():
        costs = [r.cost for r in arm_runs]
        solved = sum(1 for r in arm_runs if r.solved)
        summaries[arm] = ArmSummary(
            arm=arm,
            n=len(arm_runs),
            solved=solved,
            success_rate=solved / len(arm_runs),
            median_turns=statistics.median(r.turns for r in arm_runs),
            median_tool_calls=statistics.median(r.tool_calls for r in arm_runs),
            median_cost=statistics.median(costs),
            min_cost=min(costs),
            max_cost=max(costs),
            median_seconds=statistics.median(r.seconds for r in arm_runs),
            total_rewinds=sum(r.rewinds for r in arm_runs),
        )
    return summaries


async def run_once(
    *,
    task: Task,
    arm: str,
    client: Any,
    anthropic: Any,
    model: str,
    max_turns: int,
) -> RunResult:
    """One attempt: fresh sandbox, provision, let the agent try, verify ourselves."""
    runner = SolariRunner(client=client)
    started = time.perf_counter()
    error: str | None = None
    solved = False
    agent: Agent | None = None
    session: Session | None = None
    try:
        await runner.start()
        setup = await runner.exec(task.setup)
        if setup.exit_code != 0:
            raise RuntimeError(f"setup failed: {setup.stderr[:200]}")

        session = Session(runner=runner, reset_command=task.setup)
        agent = Agent(
            session=session,
            client=anthropic,
            model=model,
            max_turns=max_turns,
            tools=tools_for(arm),
            system=system_for(arm),
        )
        try:
            await agent.run(task.prompt)
        except RuntimeError as exc:
            error = f"{type(exc).__name__}: {exc}"

        # Never trust the agent's own account of success.
        check = await runner.exec(task.verify)
        solved = check.exit_code == 0
    except Exception as exc:  # noqa: BLE001 - one bad run must not stop the sweep
        error = f"{type(exc).__name__}: {exc}"
    finally:
        await runner.cleanup()

    return RunResult(
        task=task.name,
        arm=arm,
        solved=solved,
        turns=agent.turns if agent else 0,
        tool_calls=agent.tool_calls if agent else 0,
        input_tokens=agent.input_tokens if agent else 0,
        output_tokens=agent.output_tokens if agent else 0,
        cost=estimate_cost(
            agent.input_tokens if agent else 0, agent.output_tokens if agent else 0
        ),
        rewinds=session.revision if session else 0,
        seconds=time.perf_counter() - started,
        error=error,
    )


def write_jsonl(runs: list[RunResult], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for run in runs:
            handle.write(json.dumps(asdict(run), sort_keys=True) + "\n")
