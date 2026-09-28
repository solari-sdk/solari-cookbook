"""Solari Adapter Layer for Fault Line.

Provides dual backend implementation:
1. LiveSolariAdapter: Executes workloads, snapshots, and counterfactual forks using live Solari Sandbox API.
2. OfflineSimulatorAdapter: Executes workloads, snapshots, and forks locally in-memory for testing and offline runs.

Backend selection:
Set FAULTLINE_BACKEND=solari or FAULTLINE_BACKEND=offline.
Default: Uses LiveSolariAdapter if SOLARI_API_KEY is available, else OfflineSimulatorAdapter.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

from .workload import CRMWorkloadStore

try:
    from solari_sandbox import SandboxClient
    HAS_SOLARI_SDK = True
except ImportError:
    SandboxClient = None
    HAS_SOLARI_SDK = False


class SimulatedSnapshot:
    def __init__(self, snapshot_id: str, store: CRMWorkloadStore, name: str):
        self.snapshot_id = snapshot_id
        self.store_copy = store.clone_to_memory()
        self.name = name
        self.created_at = time.time()


class BaseSolariAdapter:
    """Abstract base class for Solari Adapters."""

    @property
    def backend_name(self) -> str:
        raise NotImplementedError

    @property
    def is_live(self) -> bool:
        raise NotImplementedError

    async def create_sandbox(
        self,
        template: str = "base",
        from_snapshot: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> tuple[str, CRMWorkloadStore]:
        raise NotImplementedError

    async def create_snapshot(
        self, sandbox_id: str, store: CRMWorkloadStore, snapshot_name: str
    ) -> str:
        raise NotImplementedError

    async def revert_to_snapshot(
        self, sandbox_id: str, snapshot_id: str
    ) -> CRMWorkloadStore:
        raise NotImplementedError

    async def kill_sandbox(self, sandbox_id: str) -> None:
        raise NotImplementedError

    async def delete_snapshot(self, snapshot_id: str) -> None:
        raise NotImplementedError

    async def cleanup_all(self) -> None:
        raise NotImplementedError


class OfflineSimulatorAdapter(BaseSolariAdapter):
    """High-speed in-memory simulated Solari Sandbox adapter for testing and offline runs."""

    def __init__(self):
        self.snapshot_count = 0
        self.fork_count = 0
        self.total_snapshot_latency_ms = 0.0
        self.total_fork_latency_ms = 0.0
        self.total_cleanup_latency_ms = 0.0

        self._snapshots: dict[str, SimulatedSnapshot] = {}
        self._active_sandboxes: set[str] = set()

    @property
    def backend_name(self) -> str:
        return "Offline Simulator"

    @property
    def is_live(self) -> bool:
        return False

    async def create_sandbox(
        self,
        template: str = "base",
        from_snapshot: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> tuple[str, CRMWorkloadStore]:
        started = time.perf_counter()
        if from_snapshot:
            self.fork_count += 1

        sandbox_id = f"sbx-{len(self._active_sandboxes)+1:03d}-{int(time.time()*1000)%10000}"
        self._active_sandboxes.add(sandbox_id)

        if from_snapshot:
            if from_snapshot not in self._snapshots:
                raise ValueError(f"Snapshot ID not found: {from_snapshot}")
            snapshot = self._snapshots[from_snapshot]
            store = snapshot.store_copy.clone_to_memory()
        else:
            store = CRMWorkloadStore(":memory:")

        duration_ms = (time.perf_counter() - started) * 1000
        if from_snapshot:
            self.total_fork_latency_ms += duration_ms

        return sandbox_id, store

    async def create_snapshot(
        self, sandbox_id: str, store: CRMWorkloadStore, snapshot_name: str
    ) -> str:
        started = time.perf_counter()
        self.snapshot_count += 1
        snapshot_id = f"snap-{snapshot_name}-{int(time.time()*1000)%100000}"

        snapshot = SimulatedSnapshot(
            snapshot_id=snapshot_id, store=store, name=snapshot_name
        )
        self._snapshots[snapshot_id] = snapshot

        duration_ms = (time.perf_counter() - started) * 1000
        self.total_snapshot_latency_ms += duration_ms
        return snapshot_id

    async def revert_to_snapshot(
        self, sandbox_id: str, snapshot_id: str
    ) -> CRMWorkloadStore:
        if snapshot_id not in self._snapshots:
            raise ValueError(f"Snapshot ID not found: {snapshot_id}")
        return self._snapshots[snapshot_id].store_copy.clone_to_memory()

    async def kill_sandbox(self, sandbox_id: str) -> None:
        started = time.perf_counter()
        if sandbox_id in self._active_sandboxes:
            self._active_sandboxes.remove(sandbox_id)
        duration_ms = (time.perf_counter() - started) * 1000
        self.total_cleanup_latency_ms += duration_ms

    async def delete_snapshot(self, snapshot_id: str) -> None:
        if snapshot_id in self._snapshots:
            del self._snapshots[snapshot_id]

    async def cleanup_all(self) -> None:
        started = time.perf_counter()
        self._active_sandboxes.clear()
        self._snapshots.clear()
        duration_ms = (time.perf_counter() - started) * 1000
        self.total_cleanup_latency_ms += duration_ms


class LiveSolariAdapter(BaseSolariAdapter):
    """Live Solari Sandbox adapter operating against actual Solari API."""

    def __init__(self, api_key: str | None = None, base_url: str = "https://api.getsolari.com"):
        self.api_key = api_key or os.getenv("SOLARI_API_KEY")
        if not self.api_key:
            raise ValueError("SOLARI_API_KEY is required for live Solari backend")
        if not HAS_SOLARI_SDK:
            raise RuntimeError("solari-sandbox SDK is not installed")
        self.base_url = base_url
        self.client = SandboxClient(api_key=self.api_key, base_url=self.base_url, call_timeout_ms=60_000)

        self.snapshot_count = 0
        self.fork_count = 0
        self.total_snapshot_latency_ms = 0.0
        self.total_fork_latency_ms = 0.0
        self.total_cleanup_latency_ms = 0.0

        self._sandboxes: dict[str, Any] = {}
        self._snapshots: set[str] = set()

    @property
    def backend_name(self) -> str:
        return "Solari"

    @property
    def is_live(self) -> bool:
        return True

    async def create_sandbox(
        self,
        template: str = "base",
        from_snapshot: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> tuple[str, CRMWorkloadStore]:
        started = time.perf_counter()
        meta = {"product": "faultline", "purpose": "agent-execution"}
        if metadata:
            meta.update(metadata)

        if from_snapshot:
            # Re-release active sandboxes before creating a clone worker to respect the 1-VM limit
            for active_id in list(self._sandboxes.keys()):
                await self.kill_sandbox(active_id)

            self.fork_count += 1
            sbx = await self.client.create(
                template=template,
                from_snapshot=from_snapshot,
                timeout_ms=10 * 60_000,
                metadata=meta,
            )
        else:
            sbx = await self.client.create(
                template=template,
                timeout_ms=10 * 60_000,
                metadata=meta,
            )

        sandbox_id = sbx.sandboxId
        self._sandboxes[sandbox_id] = sbx
        await sbx.connect()

        store = CRMWorkloadStore(":memory:")
        if from_snapshot:
            # Restore CRM state from remote file inside restored Solari Sandbox
            try:
                state_json = await sbx.files.read_text("/tmp/faultline/crm_state.json")
                state_data = json.loads(state_json)
                for lead in state_data.get("leads", []):
                    store.create_lead(lead["name"], lead["email"], lead["company"], lead["owner"], lead["status"])
                for msg in state_data.get("outbound_messages", []):
                    store.create_outbound_message(msg["lead_id"], msg["recipient"], msg["subject"], msg["body"], msg["status"])
            except Exception:
                pass
        else:
            await sbx.commands.run("mkdir", args=["-p", "/tmp/faultline"])

        duration_ms = (time.perf_counter() - started) * 1000
        if from_snapshot:
            self.total_fork_latency_ms += duration_ms

        return sandbox_id, store

    async def create_snapshot(
        self, sandbox_id: str, store: CRMWorkloadStore, snapshot_name: str
    ) -> str:
        started = time.perf_counter()
        sbx = self._sandboxes.get(sandbox_id)
        if not sbx:
            raise ValueError(f"Live Sandbox ID not found: {sandbox_id}")

        # Persist state inside live Solari Sandbox environment
        state_data = store.dump_canonical_state()
        state_json = json.dumps(state_data, indent=2)
        await sbx.files.write("/tmp/faultline/crm_state.json", state_json)

        # Call live Solari snapshot API
        snapshot_id = await sbx.snapshot(snapshot_name)
        self._snapshots.add(snapshot_id)
        self.snapshot_count += 1

        duration_ms = (time.perf_counter() - started) * 1000
        self.total_snapshot_latency_ms += duration_ms
        return snapshot_id

    async def revert_to_snapshot(
        self, sandbox_id: str, snapshot_id: str
    ) -> CRMWorkloadStore:
        # Create fresh live Solari clone from snapshot (matching Worldline pattern)
        clone_id, restored_store = await self.create_sandbox(
            template="base", from_snapshot=snapshot_id, metadata={"purpose": "probe"}
        )
        await self.kill_sandbox(clone_id)
        return restored_store

    async def kill_sandbox(self, sandbox_id: str) -> None:
        started = time.perf_counter()
        if sandbox_id in self._sandboxes:
            sbx = self._sandboxes.pop(sandbox_id)
            try:
                await self.client.kill(sandbox_id)
            except Exception:
                pass
            try:
                await sbx.close()
            except Exception:
                pass
        duration_ms = (time.perf_counter() - started) * 1000
        self.total_cleanup_latency_ms += duration_ms

    async def delete_snapshot(self, snapshot_id: str) -> None:
        if snapshot_id in self._snapshots:
            self._snapshots.remove(snapshot_id)
            try:
                await self.client.delete_snapshot(snapshot_id)
            except Exception:
                pass

    async def cleanup_all(self) -> None:
        started = time.perf_counter()
        for sbx_id in list(self._sandboxes.keys()):
            await self.kill_sandbox(sbx_id)

        for snap_id in list(self._snapshots):
            await self.delete_snapshot(snap_id)

        try:
            await self.client.aclose()
        except Exception:
            pass

        duration_ms = (time.perf_counter() - started) * 1000
        self.total_cleanup_latency_ms += duration_ms


def get_solari_adapter(backend_override: str | None = None) -> BaseSolariAdapter:
    env_backend = (backend_override or os.getenv("FAULTLINE_BACKEND", "")).lower()

    if env_backend == "solari":
        return LiveSolariAdapter()
    elif env_backend == "offline":
        return OfflineSimulatorAdapter()

    api_key = os.getenv("SOLARI_API_KEY")
    if api_key and HAS_SOLARI_SDK:
        try:
            return LiveSolariAdapter(api_key=api_key)
        except Exception:
            return OfflineSimulatorAdapter()

    return OfflineSimulatorAdapter()


def SolariSandboxAdapter(backend_override: str | None = None) -> BaseSolariAdapter:
    return get_solari_adapter(backend_override)
