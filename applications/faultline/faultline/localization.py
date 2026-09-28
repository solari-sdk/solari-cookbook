"""Fault Localization Engine for Fault Line.

Implements Linear, Binary, Parallel, and Adaptive search strategies to locate
the first observed invalid state checkpoint in execution lineage.
"""

from __future__ import annotations

import asyncio
import time

from .checkpoint import CheckpointManager
from .models import ProbeRecord, StrategyResult
from .solari_adapter import SolariSandboxAdapter
from .verifier import IndependentVerifier


class FaultLocalizer:
    """Locates the first observed invalid checkpoint using various search strategies."""

    def __init__(
        self,
        adapter: SolariSandboxAdapter,
        verifier: IndependentVerifier | None = None,
        max_concurrency: int | None = None,
    ):
        self.adapter = adapter
        self.verifier = verifier or IndependentVerifier()
        if max_concurrency is None:
            max_concurrency = 1 if adapter.is_live else 4
        self.max_concurrency = max_concurrency

    async def _probe_checkpoint(
        self,
        probe_idx: int,
        checkpoint_id: str,
        checkpoint_mgr: CheckpointManager,
        sandbox_id: str,
    ) -> ProbeRecord:
        started = time.perf_counter()
        chk = checkpoint_mgr.get_checkpoint(checkpoint_id)
        restored_store = await self.adapter.revert_to_snapshot(sandbox_id, chk.snapshot_id)
        v_res = self.verifier.verify_store(restored_store)
        duration_ms = (time.perf_counter() - started) * 1000

        return ProbeRecord(
            probe_index=probe_idx,
            checkpoint_id=chk.checkpoint_id,
            step_number=chk.step_number,
            state_digest=chk.state_digest,
            is_valid=v_res.passed,
            probe_latency_ms=duration_ms,
        )

    async def linear_search(
        self, checkpoint_mgr: CheckpointManager, sandbox_id: str
    ) -> StrategyResult:
        """Sequential search: 1 -> 2 -> ... -> N."""
        started = time.perf_counter()
        probes: list[ProbeRecord] = []
        checkpoints = checkpoint_mgr.checkpoints
        first_invalid_step: int | None = None

        for idx, chk in enumerate(checkpoints, start=1):
            probe = await self._probe_checkpoint(
                idx, chk.checkpoint_id, checkpoint_mgr, sandbox_id
            )
            probes.append(probe)
            if not probe.is_valid:
                first_invalid_step = chk.step_number
                break

        duration_ms = (time.perf_counter() - started) * 1000

        return StrategyResult(
            strategy_name="Linear",
            probes_count=len(probes),
            localization_time_ms=duration_ms,
            forks_count=0,
            snapshots_count=self.adapter.snapshot_count,
            replay_steps_count=0,
            verification_time_ms=sum(p.probe_latency_ms for p in probes),
            total_time_ms=duration_ms,
            first_invalid_step=first_invalid_step,
            validated_causal_step=None,  # Requires counterfactual repair
            probe_history=probes,
        )

    async def binary_search(
        self, checkpoint_mgr: CheckpointManager, sandbox_id: str
    ) -> StrategyResult:
        """Binary search to locate first invalid checkpoint."""
        started = time.perf_counter()
        probes: list[ProbeRecord] = []
        checkpoints = checkpoint_mgr.checkpoints
        if not checkpoints:
            return StrategyResult(
                strategy_name="Binary",
                probes_count=0,
                localization_time_ms=0,
                forks_count=0,
                snapshots_count=0,
                replay_steps_count=0,
                verification_time_ms=0,
                total_time_ms=0,
                first_invalid_step=None,
                validated_causal_step=None,
            )

        low = 0
        high = len(checkpoints) - 1
        first_invalid_step: int | None = None
        probe_counter = 1

        # Quick check if final step fails
        final_probe = await self._probe_checkpoint(
            probe_counter, checkpoints[high].checkpoint_id, checkpoint_mgr, sandbox_id
        )
        probes.append(final_probe)
        probe_counter += 1
        if final_probe.is_valid:
            # Entire run passed!
            return StrategyResult(
                strategy_name="Binary",
                probes_count=len(probes),
                localization_time_ms=(time.perf_counter() - started) * 1000,
                forks_count=0,
                snapshots_count=self.adapter.snapshot_count,
                replay_steps_count=0,
                verification_time_ms=sum(p.probe_latency_ms for p in probes),
                total_time_ms=(time.perf_counter() - started) * 1000,
                first_invalid_step=None,
                validated_causal_step=None,
                probe_history=probes,
            )

        # Binary search range
        while low <= high:
            mid = (low + high) // 2
            probe = await self._probe_checkpoint(
                probe_counter, checkpoints[mid].checkpoint_id, checkpoint_mgr, sandbox_id
            )
            probes.append(probe)
            probe_counter += 1

            if not probe.is_valid:
                first_invalid_step = checkpoints[mid].step_number
                high = mid - 1
            else:
                low = mid + 1

        duration_ms = (time.perf_counter() - started) * 1000

        return StrategyResult(
            strategy_name="Binary",
            probes_count=len(probes),
            localization_time_ms=duration_ms,
            forks_count=0,
            snapshots_count=self.adapter.snapshot_count,
            replay_steps_count=0,
            verification_time_ms=sum(p.probe_latency_ms for p in probes),
            total_time_ms=duration_ms,
            first_invalid_step=first_invalid_step,
            validated_causal_step=None,
            probe_history=probes,
        )

    async def parallel_search(
        self,
        checkpoint_mgr: CheckpointManager,
        sandbox_id: str,
        max_concurrency: int | None = None,
    ) -> StrategyResult:
        """Parallel search probing multiple checkpoint branches concurrently with bounded concurrency."""
        started = time.perf_counter()
        checkpoints = checkpoint_mgr.checkpoints
        if not checkpoints:
            return StrategyResult(
                strategy_name="Parallel",
                probes_count=0,
                localization_time_ms=0,
                forks_count=0,
                snapshots_count=0,
                replay_steps_count=0,
                verification_time_ms=0,
                total_time_ms=0,
                first_invalid_step=None,
                validated_causal_step=None,
            )

        concurrency = max_concurrency or self.max_concurrency
        sem = asyncio.Semaphore(max(1, concurrency))

        async def _bounded_probe(idx, chk_id):
            async with sem:
                return await self._probe_checkpoint(idx, chk_id, checkpoint_mgr, sandbox_id)

        # Partition sample
        sample_indices = list(range(0, len(checkpoints), max(1, len(checkpoints) // 4)))
        if (len(checkpoints) - 1) not in sample_indices:
            sample_indices.append(len(checkpoints) - 1)

        tasks = [
            _bounded_probe(idx + 1, checkpoints[i].checkpoint_id)
            for idx, i in enumerate(sample_indices)
        ]

        sampled_probes: list[ProbeRecord] = list(await asyncio.gather(*tasks))
        probes: list[ProbeRecord] = list(sampled_probes)

        first_invalid_sample_idx = None
        last_valid_sample_idx = 0
        for i, idx in enumerate(sample_indices):
            if not sampled_probes[i].is_valid:
                first_invalid_sample_idx = idx
                if i > 0:
                    last_valid_sample_idx = sample_indices[i - 1]
                break

        first_invalid_step: int | None = None
        if first_invalid_sample_idx is not None:
            window_indices = list(range(last_valid_sample_idx + 1, first_invalid_sample_idx + 1))
            window_tasks = [
                _bounded_probe(len(probes) + k + 1, checkpoints[idx].checkpoint_id)
                for k, idx in enumerate(window_indices)
            ]
            window_probes = list(await asyncio.gather(*window_tasks))
            probes.extend(window_probes)
            invalid_window = [p for p in window_probes if not p.is_valid]
            if invalid_window:
                first_invalid_step = min(p.step_number for p in invalid_window)
            else:
                first_invalid_step = checkpoints[first_invalid_sample_idx].step_number

        duration_ms = (time.perf_counter() - started) * 1000

        return StrategyResult(
            strategy_name="Parallel",
            probes_count=len(probes),
            localization_time_ms=duration_ms,
            forks_count=len(sample_indices),
            snapshots_count=self.adapter.snapshot_count,
            replay_steps_count=0,
            verification_time_ms=max((p.probe_latency_ms for p in probes), default=0),
            total_time_ms=duration_ms,
            first_invalid_step=first_invalid_step,
            validated_causal_step=None,
            probe_history=probes,
        )

    async def adaptive_search(
        self, checkpoint_mgr: CheckpointManager, sandbox_id: str
    ) -> StrategyResult:
        """Adaptive search combining state entropy/digest change detection with exponential probing."""
        started = time.perf_counter()
        probes: list[ProbeRecord] = []
        checkpoints = checkpoint_mgr.checkpoints

        # Probe points where state digest changed from previous step
        digest_change_steps = []
        for i in range(1, len(checkpoints)):
            if checkpoints[i].state_digest != checkpoints[i - 1].state_digest:
                digest_change_steps.append(i)

        probe_counter = 1
        first_invalid_step: int | None = None

        # Binary search over the subset of state-mutating steps
        low = 0
        high = len(digest_change_steps) - 1
        while low <= high:
            mid = (low + high) // 2
            chk_idx = digest_change_steps[mid]
            probe = await self._probe_checkpoint(
                probe_counter, checkpoints[chk_idx].checkpoint_id, checkpoint_mgr, sandbox_id
            )
            probes.append(probe)
            probe_counter += 1

            if not probe.is_valid:
                first_invalid_step = checkpoints[chk_idx].step_number
                high = mid - 1
            else:
                low = mid + 1

        duration_ms = (time.perf_counter() - started) * 1000

        return StrategyResult(
            strategy_name="Adaptive",
            probes_count=len(probes),
            localization_time_ms=duration_ms,
            forks_count=0,
            snapshots_count=self.adapter.snapshot_count,
            replay_steps_count=0,
            verification_time_ms=sum(p.probe_latency_ms for p in probes),
            total_time_ms=duration_ms,
            first_invalid_step=first_invalid_step,
            validated_causal_step=None,
            probe_history=probes,
        )
