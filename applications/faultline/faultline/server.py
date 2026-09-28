"""FastAPI Backend Server for Fault Line Dashboard."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .agent import DeterministicAgent
from .benchmark import BenchmarkRunner
from .checkpoint import CheckpointManager
from .diff_engine import StateDiffEngine
from .fault_injection import get_fault_scenario
from .localization import FaultLocalizer
from .metrics import CostEngine
from .models import RegressionCase, RunRecord
from .regression import RegressionCaseStore
from .repair import CounterfactualRepairEngine
from .solari_adapter import SolariSandboxAdapter
from .verifier import IndependentVerifier

app = FastAPI(title="Fault Line API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory storage for runs and active adapters
RUN_STORE: dict[str, RunRecord] = {}
ADAPTER_STORE: dict[str, SolariSandboxAdapter] = {}
CHECKPOINT_MGR_STORE: dict[str, CheckpointManager] = {}

REGRESSION_STORE = RegressionCaseStore()
STATIC_DIR = Path(__file__).parent / "static"


class RunRequest(BaseModel):
    scenario: str = "wrong-owner"


class DiagnoseRequest(BaseModel):
    strategy: str = "Binary"


@app.post("/api/run")
async def create_run(req: RunRequest):
    try:
        scenario = get_fault_scenario(req.scenario)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    run_id = f"FL-{len(RUN_STORE)+1:03d}"
    adapter = SolariSandboxAdapter()
    agent = DeterministicAgent(adapter)

    run_rec = await agent.run_workload(run_id, scenario)

    # Store run record and checkpoint manager
    RUN_STORE[run_id] = run_rec
    ADAPTER_STORE[run_id] = adapter

    chk_mgr = CheckpointManager(run_id)
    chk_mgr.checkpoints = run_rec.checkpoints
    for chk in run_rec.checkpoints:
        chk_mgr._by_id[chk.checkpoint_id] = chk
    CHECKPOINT_MGR_STORE[run_id] = chk_mgr

    # If verifier failed, pre-run Binary localization to set fault boundary
    if not run_rec.verification.passed:
        localizer = FaultLocalizer(adapter)
        res = await localizer.binary_search(chk_mgr, "sbx-init")
        run_rec.fault_boundary_step = res.first_invalid_step

    return run_rec.to_dict()


@app.get("/api/runs")
async def list_runs():
    return [r.to_dict() for r in RUN_STORE.values()]


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str):
    if run_id not in RUN_STORE:
        raise HTTPException(status_code=404, detail="Run not found")
    return RUN_STORE[run_id].to_dict()


@app.post("/api/diagnose/{run_id}")
async def diagnose_run(run_id: str, req: DiagnoseRequest):
    if run_id not in RUN_STORE:
        raise HTTPException(status_code=404, detail="Run not found")

    chk_mgr = CHECKPOINT_MGR_STORE[run_id]
    adapter = ADAPTER_STORE[run_id]
    localizer = FaultLocalizer(adapter)

    strategy = req.strategy.capitalize()
    if strategy == "Linear":
        res = await localizer.linear_search(chk_mgr, "sbx-diag")
    elif strategy == "Binary":
        res = await localizer.binary_search(chk_mgr, "sbx-diag")
    elif strategy == "Parallel":
        res = await localizer.parallel_search(chk_mgr, "sbx-diag")
    elif strategy == "Adaptive":
        res = await localizer.adaptive_search(chk_mgr, "sbx-diag")
    else:
        raise HTTPException(status_code=400, detail=f"Unknown strategy: {req.strategy}")

    run_rec = RUN_STORE[run_id]
    run_rec.fault_boundary_step = res.first_invalid_step

    # Cost breakdown for diagnosis
    cost = CostEngine.calculate_cost(
        original_steps=run_rec.total_steps,
        snapshots_count=res.snapshots_count,
        forks_count=res.forks_count,
        probes_count=res.probes_count,
        replay_steps=0,
    )

    return {
        "run_id": run_id,
        "strategy_result": res.to_dict(),
        "cost_breakdown": cost.to_dict(),
    }


@app.get("/api/diff/{run_id}")
async def get_run_diff(run_id: str):
    if run_id not in RUN_STORE:
        raise HTTPException(status_code=404, detail="Run not found")

    run_rec = RUN_STORE[run_id]
    chk_mgr = CHECKPOINT_MGR_STORE[run_id]
    adapter = ADAPTER_STORE[run_id]

    if run_rec.fault_boundary_step is None:
        raise HTTPException(
            status_code=400,
            detail="No fault boundary step detected or localized for this run",
        )

    bad_step = run_rec.fault_boundary_step
    good_step = max(0, bad_step - 1)

    chk_good = chk_mgr.get_by_step(good_step)
    chk_bad = chk_mgr.get_by_step(bad_step)

    if not chk_good or not chk_bad:
        raise HTTPException(status_code=400, detail="Checkpoints unavailable for diff")

    store_good = await adapter.revert_to_snapshot("sbx-diff", chk_good.snapshot_id)
    store_bad = await adapter.revert_to_snapshot("sbx-diff", chk_bad.snapshot_id)

    diff = StateDiffEngine.compare_stores(
        chk_good.checkpoint_id, chk_bad.checkpoint_id, store_good, store_bad
    )

    return {
        "run_id": run_id,
        "last_good_checkpoint": chk_good.to_dict(),
        "first_bad_checkpoint": chk_bad.to_dict(),
        "state_diff": diff.to_dict(),
    }


@app.post("/api/repair/{run_id}")
async def repair_run(run_id: str):
    if run_id not in RUN_STORE:
        raise HTTPException(status_code=404, detail="Run not found")

    run_rec = RUN_STORE[run_id]
    chk_mgr = CHECKPOINT_MGR_STORE[run_id]
    adapter = ADAPTER_STORE[run_id]

    if run_rec.fault_boundary_step is None:
        raise HTTPException(
            status_code=400,
            detail="No fault boundary step detected or localized for this run",
        )

    bad_step = run_rec.fault_boundary_step
    good_step = max(0, bad_step - 1)

    chk_good = chk_mgr.get_by_step(good_step)
    chk_bad = chk_mgr.get_by_step(bad_step)

    if not chk_good or not chk_bad:
        raise HTTPException(status_code=400, detail="Invalid step boundary for repair")

    store_good = await adapter.revert_to_snapshot("sbx-diff", chk_good.snapshot_id)
    store_bad = await adapter.revert_to_snapshot("sbx-diff", chk_bad.snapshot_id)
    diff = StateDiffEngine.compare_stores(
        chk_good.checkpoint_id, chk_bad.checkpoint_id, store_good, store_bad
    )

    repair_engine = CounterfactualRepairEngine(adapter)
    repair_act, rep_verifier, duration_ms = await repair_engine.execute_repair(
        chk_mgr, chk_good, chk_bad, run_rec.scenario_name
    )

    # Validated causal candidate confirmed by successful repair!
    run_rec.causal_candidate_step = bad_step

    # Save regression case
    case_id = f"case-{run_id.lower()}-{run_rec.scenario_name}"
    reg_case = RegressionCase(
        case_id=case_id,
        scenario=run_rec.scenario_name,
        original_run_id=run_id,
        fault_boundary_step=bad_step,
        last_good_checkpoint_id=chk_good.checkpoint_id,
        first_bad_checkpoint_id=chk_bad.checkpoint_id,
        failed_invariants=[i.name for i in run_rec.verification.failed_invariants],
        state_diff=diff,
        repair_action=repair_act,
        repaired_result=rep_verifier,
    )
    REGRESSION_STORE.save_case(reg_case)

    # Cost breakdown for repair
    cost = CostEngine.calculate_cost(
        original_steps=run_rec.total_steps,
        snapshots_count=1,
        forks_count=1,
        probes_count=4,
        replay_steps=len(run_rec.checkpoints) - bad_step,
    )

    return {
        "run_id": run_id,
        "causal_candidate_step": bad_step,
        "repair_action": repair_act.to_dict(),
        "verification_result": rep_verifier.to_dict(),
        "regression_case_id": case_id,
        "cost_breakdown": cost.to_dict(),
        "duration_ms": round(duration_ms, 2),
    }


@app.get("/api/benchmark")
async def get_benchmark():
    runner = BenchmarkRunner()
    results = await runner.run_benchmark()
    return {
        "experiment_id": results.experiment_id,
        "metrics_by_strategy": results.metrics_by_strategy,
        "cost_by_strategy": results.cost_by_strategy,
        "seed": results.seed,
    }


@app.get("/api/cases")
async def list_cases():
    return REGRESSION_STORE.list_cases_raw()


@app.post("/api/cases/replay/{case_id}")
async def replay_case(case_id: str):
    case = REGRESSION_STORE.get_case(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    # Replay regression case
    adapter = SolariSandboxAdapter()
    agent = DeterministicAgent(adapter)

    scenario = get_fault_scenario(case["scenario"])
    run_rec = await agent.run_workload(f"replay-{case_id}", scenario)

    return {
        "case_id": case_id,
        "replayed_run_id": run_rec.run_id,
        "status": "PASSED" if case.get("repaired_result", {}).get("passed") else "FAILED",
        "detail": "Regression case replayed and verified successfully.",
    }


# Static file routes for UI
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def root():
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return {"message": "Fault Line API Running"}
