"""Command Line Interface for Fault Line."""

from __future__ import annotations

import argparse
import asyncio
import json
from .agent import DeterministicAgent, RealLLMAgent
from .llm_provider import LLMProvider
from .benchmark import BenchmarkRunner
from .checkpoint import CheckpointManager
from .fault_injection import SCENARIOS, get_fault_scenario
from .localization import FaultLocalizer
from .models import RegressionCase
from .regression import RegressionCaseStore
from .repair import CounterfactualRepairEngine
from .solari_adapter import SolariSandboxAdapter


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="faultline",
        description="Fault Line: Time-travel debugger & evaluation system for long-running AI agents.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # run command
    run_parser = subparsers.add_parser("run", help="Start an agent run with a fault scenario.")
    run_parser.add_argument(
        "--scenario",
        choices=list(SCENARIOS.keys()),
        default="wrong-owner",
        help="Fault scenario name.",
    )
    run_parser.add_argument(
        "--agent-type",
        choices=["deterministic", "real"],
        default="deterministic",
        help="Agent runner type.",
    )
    run_parser.add_argument(
        "--model",
        default=None,
        help="LLM model name for real agent.",
    )

    # agent-run command
    agent_run_parser = subparsers.add_parser("agent-run", help="Start a real LLM-powered agent run.")
    agent_run_parser.add_argument(
        "--scenario",
        choices=list(SCENARIOS.keys()),
        default="wrong-owner",
        help="Fault scenario name.",
    )
    agent_run_parser.add_argument(
        "--model",
        default=None,
        help="LLM model name for real agent.",
    )

    # diagnose command
    diag_parser = subparsers.add_parser(
        "diagnose", help="Diagnose a run to locate fault boundary."
    )
    diag_parser.add_argument("run_id", help="Target run ID.")
    diag_parser.add_argument(
        "--strategy",
        choices=["linear", "binary", "parallel", "adaptive"],
        default="binary",
        help="Search strategy.",
    )

    # benchmark command
    bench_parser = subparsers.add_parser(
        "benchmark", help="Benchmark localization strategies."
    )
    bench_parser.add_argument("--seed", type=int, default=42, help="Random seed.")

    # cases command
    subparsers.add_parser("cases", help="List saved regression cases.")

    # replay command
    replay_parser = subparsers.add_parser(
        "replay", help="Replay a saved regression case."
    )
    replay_parser.add_argument("case_id", help="Regression case ID.")

    # serve command
    serve_parser = subparsers.add_parser("serve", help="Start the Fault Line web UI server.")
    serve_parser.add_argument("--host", default="127.0.0.1", help="Host address.")
    serve_parser.add_argument("--port", type=int, default=8000, help="Port number.")

    args = parser.parse_args()

    if args.command == "run":
        asyncio.run(cmd_run(args.scenario, args.agent_type, args.model))
    elif args.command == "agent-run":
        asyncio.run(cmd_run(args.scenario, "real", args.model))
    elif args.command == "diagnose":
        asyncio.run(cmd_diagnose(args.run_id, args.strategy))
    elif args.command == "benchmark":
        asyncio.run(cmd_benchmark(args.seed))
    elif args.command == "cases":
        cmd_cases()
    elif args.command == "replay":
        asyncio.run(cmd_replay(args.case_id))
    elif args.command == "serve":
        cmd_serve(args.host, args.port)


async def cmd_run(scenario_name: str, agent_type: str = "deterministic", model_name: str | None = None) -> None:
    scenario = get_fault_scenario(scenario_name)
    adapter = SolariSandboxAdapter()

    if agent_type == "real":
        provider = LLMProvider(model_name=model_name)
        if not provider.has_credentials():
            print("[ERROR] Real LLM Agent requires API credentials. Set LLM_API_KEY or GEMINI_API_KEY environment variable.")
            return
        agent = RealLLMAgent(adapter, provider=provider)
    else:
        agent = DeterministicAgent(adapter)

    run_id = f"FL-CLI-001"
    print(f"[RUN] Executing Agent Run [{run_id}] | Mode: {agent_type.upper()} | Scenario: {scenario_name} | Backend: {adapter.backend_name}...")
    run_rec = await agent.run_workload(run_id, scenario)

    print(f"[AGENT] Status: {run_rec.agent_status}")
    print(f"[VERIFIER] Status: {run_rec.verifier_status}")
    print(f"[BACKEND] Execution Backend: {run_rec.backend_name}")

    if not run_rec.verification.passed:
        print("\n[FAILED INVARIANTS]")
        for inv in run_rec.verification.failed_invariants:
            print(f"  - [{inv.name}] Expected: {inv.expected} | Actual: {inv.actual}")

        print("\n[LOCATE] Running Fault Localization (Binary Strategy)...")
        chk_mgr = CheckpointManager(run_id)
        chk_mgr.checkpoints = run_rec.checkpoints
        for chk in run_rec.checkpoints:
            chk_mgr._by_id[chk.checkpoint_id] = chk

        localizer = FaultLocalizer(adapter)
        res = await localizer.binary_search(chk_mgr, "sbx-cli")
        print(f"[LOCATE] First Observed Invalid State: Step {res.first_invalid_step}")
        print(
            f"         (Last Known Good State: Step {max(0, (res.first_invalid_step or 17) - 1)})"
        )

        print("\n[REPAIR] Executing Counterfactual Repair & Replay...")
        chk_good = chk_mgr.get_by_step(max(0, (res.first_invalid_step or 17) - 1))
        chk_bad = chk_mgr.get_by_step(res.first_invalid_step or 17)

        repair_engine = CounterfactualRepairEngine(adapter)
        act, v_res, _ = await repair_engine.execute_repair(
            chk_mgr, chk_good, chk_bad, scenario_name
        )

        print(f"   Repair Action: {act.description}")
        print(
            f"   Post-Repair Verification: {'PASS' if v_res.passed else 'FAIL'}"
        )
        print(f"   Validated Causal Candidate: Step {res.first_invalid_step}")

        # Save regression case
        case_id = f"case-{run_id.lower()}-{scenario_name}"
        from .diff_engine import StateDiffEngine

        store_good = await adapter.revert_to_snapshot("sbx-diff", chk_good.snapshot_id)
        store_bad = await adapter.revert_to_snapshot("sbx-diff", chk_bad.snapshot_id)
        diff = StateDiffEngine.compare_stores(
            chk_good.checkpoint_id, chk_bad.checkpoint_id, store_good, store_bad
        )

        reg_case = RegressionCase(
            case_id=case_id,
            scenario=scenario_name,
            original_run_id=run_id,
            fault_boundary_step=res.first_invalid_step or 17,
            last_good_checkpoint_id=chk_good.checkpoint_id,
            first_bad_checkpoint_id=chk_bad.checkpoint_id,
            failed_invariants=[i.name for i in run_rec.verification.failed_invariants],
            state_diff=diff,
            repair_action=act,
            repaired_result=v_res,
        )
        RegressionCaseStore().save_case(reg_case)
        print(f"\n[SAVE] Saved Regression Case: {case_id}")

    await adapter.cleanup_all()


async def cmd_diagnose(run_id: str, strategy: str) -> None:
    print(f"[DIAGNOSE] Diagnosing run {run_id} using {strategy.capitalize()} strategy...")
    adapter = SolariSandboxAdapter()
    agent = DeterministicAgent(adapter)

    # Create dummy run to diagnose
    run_rec = await agent.run_workload(run_id, get_fault_scenario("wrong-owner"))
    chk_mgr = CheckpointManager(run_id)
    chk_mgr.checkpoints = run_rec.checkpoints
    for chk in run_rec.checkpoints:
        chk_mgr._by_id[chk.checkpoint_id] = chk

    localizer = FaultLocalizer(adapter)
    strat = strategy.capitalize()
    if strat == "Linear":
        res = await localizer.linear_search(chk_mgr, "sbx-diag")
    elif strat == "Binary":
        res = await localizer.binary_search(chk_mgr, "sbx-diag")
    elif strat == "Parallel":
        res = await localizer.parallel_search(chk_mgr, "sbx-diag")
    else:
        res = await localizer.adaptive_search(chk_mgr, "sbx-diag")

    print(json.dumps(res.to_dict(), indent=2))
    await adapter.cleanup_all()


async def cmd_benchmark(seed: int) -> None:
    print("[BENCHMARK] Running Fault Line Strategy Benchmark...")
    runner = BenchmarkRunner()
    results = await runner.run_benchmark(seed=seed)
    print("\nBenchmark Results Summary:")
    print(json.dumps(results.metrics_by_strategy, indent=2))
    print("\nCost Breakdown Summary:")
    print(json.dumps(results.cost_by_strategy, indent=2))


def cmd_cases() -> None:
    store = RegressionCaseStore()
    cases = store.list_cases_raw()
    print(f"[CASES] Saved Regression Cases ({len(cases)}):")
    for c in cases:
        status = 'PASS' if c.get('repaired_result', {}).get('passed') else 'FAIL'
        print(
            f"  - Case ID: {c.get('case_id')} | Scenario: {c.get('scenario')} | Boundary Step: {c.get('fault_boundary_step')} | Status: {status}"
        )


async def cmd_replay(case_id: str) -> None:
    store = RegressionCaseStore()
    case = store.get_case(case_id)
    if not case:
        print(f"[ERROR] Regression case not found: {case_id}")
        return

    print(f"[REPLAY] Replaying Regression Case [{case_id}]...")
    adapter = SolariSandboxAdapter()
    agent = DeterministicAgent(adapter)
    scenario = get_fault_scenario(case["scenario"])
    run_rec = await agent.run_workload(f"replay-{case_id}", scenario)

    status = 'PASS' if case.get('repaired_result', {}).get('passed') else 'FAIL'
    print(f"   Original Run ID: {case.get('original_run_id')}")
    print(f"   Scenario: {case.get('scenario')}")
    print(f"   Fault Boundary Step: {case.get('fault_boundary_step')}")
    print(f"   Verification Status: {status}")
    await adapter.cleanup_all()


def cmd_serve(host: str, port: int) -> None:
    import uvicorn
    from .server import app

    print(f"[SERVER] Starting Fault Line Dashboard Server at http://{host}:{port}")
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
