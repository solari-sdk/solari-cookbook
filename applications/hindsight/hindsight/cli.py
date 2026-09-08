"""Command line entry point."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from anthropic import AsyncAnthropic
from solari_sandbox import SandboxClient

from hindsight.agent import Agent
from hindsight.config import BASE_URL, load_key, redact
from hindsight.cost import estimate_cost
from hindsight.sandbox import SolariRunner
from hindsight.session import Session
from hindsight.bench import ArmSummary, run_once, summarise, write_jsonl
from hindsight.tasks import get_task

APP_ROOT = Path(__file__).resolve().parent.parent


def _trace(name: str, args: dict) -> None:
    detail = args.get("command") or args.get("label") or args.get("checkpoint_id", "")
    print(f"  [{name}] {str(detail)[:110]}")


async def run_benchmark_task(
    name: str, *, env_file: Path, model: str, max_turns: int
) -> int:
    """Provision a task, let the agent attempt it, then check it independently."""
    task = get_task(name)
    solari_key = load_key("SOLARI_API_KEY", env_file)
    anthropic_key = load_key("ANTHROPIC_API_KEY", env_file)

    async with SandboxClient(api_key=solari_key, base_url=BASE_URL) as client:
        runner = SolariRunner(client=client)
        try:
            await runner.start()
            setup = await runner.exec(task.setup)
            if setup.exit_code != 0:
                raise SystemExit(f"task setup failed: {setup.stderr[:400]}")
            print("task    :", task.name, "provisioned")

            session = Session(runner=runner)
            agent = Agent(
                session=session,
                client=AsyncAnthropic(api_key=anthropic_key),
                model=model,
                max_turns=max_turns,
                on_tool=_trace,
            )
            try:
                await agent.run(task.prompt)
            except RuntimeError as exc:
                print("agent   : stopped -", exc)

            # Verified by us, not by the agent's own claim of success.
            check = await runner.exec(task.verify)
            solved = check.exit_code == 0

            print("solved  :", solved, f"({check.stdout.strip()})")
            print("checkpoints:", len(session.tree.checkpoints))
            for c in session.tree.checkpoints:
                print(f"  {c.id} {c.label} parent={c.parent}")
            print("rewinds :", session.revision)
            print("tokens  :", agent.input_tokens, "in /", agent.output_tokens, "out")
            print("cost    : $%.3f" % estimate_cost(agent.input_tokens, agent.output_tokens))
            return 0 if solved else 1
        finally:
            errors = await runner.cleanup()
            print("cleanup :", "; ".join(errors) if errors else "ok")


async def run_task(task: str, *, env_file: Path, model: str, max_turns: int) -> int:
    solari_key = load_key("SOLARI_API_KEY", env_file)
    anthropic_key = load_key("ANTHROPIC_API_KEY", env_file)

    async with SandboxClient(api_key=solari_key, base_url=BASE_URL) as client:
        runner = SolariRunner(client=client)
        errors: list[str] = []
        try:
            await runner.start()
            print("sandbox :", redact(runner.sandbox_id))

            session = Session(runner=runner)
            agent = Agent(
                session=session,
                client=AsyncAnthropic(api_key=anthropic_key),
                model=model,
                max_turns=max_turns,
            )
            answer = await agent.run(task)

            print("\n--- answer ---")
            print(answer)
            print("\ncheckpoints:", len(session.tree.checkpoints))
            for checkpoint in session.tree.checkpoints:
                print(
                    f"  {checkpoint.id} {checkpoint.label} "
                    f"parent={checkpoint.parent} snap={redact(checkpoint.snapshot_id)}"
                )
            print("rewinds :", session.revision)
            print("tokens  :", agent.input_tokens, "in /", agent.output_tokens, "out")
            return 0
        finally:
            errors = await runner.cleanup()
            print("cleanup :", "; ".join(errors) if errors else "ok")


async def run_bench(
    *,
    task_name: str,
    arms: list[str],
    n: int,
    env_file: Path,
    model: str,
    max_turns: int,
    out: Path,
    budget: float,
) -> int:
    task = get_task(task_name)
    solari_key = load_key("SOLARI_API_KEY", env_file)
    anthropic = AsyncAnthropic(api_key=load_key("ANTHROPIC_API_KEY", env_file))

    runs = []
    spent = 0.0
    async with SandboxClient(api_key=solari_key, base_url=BASE_URL) as client:
        for arm in arms:
            for attempt in range(1, n + 1):
                if spent >= budget:
                    print(f"budget ${budget:.2f} reached - stopping early")
                    break
                result = await run_once(
                    task=task,
                    arm=arm,
                    client=client,
                    anthropic=anthropic,
                    model=model,
                    max_turns=max_turns,
                )
                spent += result.cost
                runs.append(result)
                print(
                    f"{arm:10} {attempt}/{n}  solved={result.solved!s:5} "
                    f"turns={result.turns:2} tools={result.tool_calls:2} "
                    f"rewinds={result.rewinds} ${result.cost:.3f} "
                    f"{result.seconds:.0f}s"
                    + (f"  [{result.error[:60]}]" if result.error else "")
                )

    write_jsonl(runs, out)
    print()
    print(f"raw results: {out}  (total ${spent:.2f})")
    print()
    _print_summary(summarise(runs))
    return 0


def _print_summary(summaries: dict[str, ArmSummary]) -> None:
    header = f"{'arm':10} {'n':>2} {'solved':>7} {'turns':>6} {'tools':>6} {'cost':>8} {'spread':>15} {'rewinds':>8}"
    print(header)
    print("-" * len(header))
    for arm, s in summaries.items():
        print(
            f"{arm:10} {s.n:>2} {s.solved:>3}/{s.n:<3} {s.median_turns:>6.1f} "
            f"{s.median_tool_calls:>6.1f} {s.median_cost:>8.3f} "
            f"{s.min_cost:>6.3f}-{s.max_cost:<8.3f} {s.total_rewinds:>8}"
        )


def main(argv: list[str] | None = None) -> int:
    # Windows consoles default to cp1252, and both model prose and our own
    # redaction ellipsis are outside it — printing either raises mid-run.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(prog="hindsight")
    parser.add_argument("--env-file", type=Path, default=APP_ROOT.parent.parent / ".env")
    parser.add_argument("--model", default="claude-opus-5")
    parser.add_argument("--max-turns", type=int, default=25)
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run one task in a sandbox")
    run.add_argument("task")

    task_cmd = sub.add_parser("task", help="run a benchmark task and verify it")
    task_cmd.add_argument("name")

    bench = sub.add_parser("bench", help="compare arms on a task")
    bench.add_argument("--task", default="ledger-migration")
    bench.add_argument("--arms", default="none,rebuild,hindsight")
    bench.add_argument("--n", type=int, default=3)
    bench.add_argument("--out", type=Path, default=APP_ROOT / "proof" / "runs.jsonl")
    bench.add_argument("--budget", type=float, default=6.0)

    args = parser.parse_args(argv)
    if args.command == "run":
        return asyncio.run(
            run_task(
                args.task,
                env_file=args.env_file,
                model=args.model,
                max_turns=args.max_turns,
            )
        )
    if args.command == "task":
        return asyncio.run(
            run_benchmark_task(
                args.name,
                env_file=args.env_file,
                model=args.model,
                max_turns=args.max_turns,
            )
        )
    if args.command == "bench":
        return asyncio.run(
            run_bench(
                task_name=args.task,
                arms=[a.strip() for a in args.arms.split(",") if a.strip()],
                n=args.n,
                env_file=args.env_file,
                model=args.model,
                max_turns=args.max_turns,
                out=args.out,
                budget=args.budget,
            )
        )
    raise AssertionError(f"unhandled command: {args.command}")
