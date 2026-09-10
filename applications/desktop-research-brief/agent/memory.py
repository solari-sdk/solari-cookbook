"""Working memory + checkpoint. One JSON file, rewritten atomically after every step.

Three things live here, and nothing else:
  findings  - facts with category, confidence, source URL, and the step that produced them
  visited   - URLs already read, so the planner/brain never re-fetch blindly
  steps     - the action log: what was done, what was observed (frame file + digest)

Design choices, stated so they can be argued with:
- No embeddings. Dozens of findings fit in a prompt as a numbered list and stay auditable.
- Atomic write (tmp + os.replace): a crash mid-write cannot corrupt the checkpoint.
- Dedupe is exact on normalised text. Semantic dedupe is delegated to the model, which sees
  memory before extracting and is told not to repeat it.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

CATEGORIES = (
    "problem", "approach", "product", "team", "tech", "funding", "hiring", "news", "open_question", "other",
)


@dataclass
class Finding:
    fact: str
    category: str
    confidence: str  # high | medium | low
    source_url: str
    step: int
    quote: str = ""


@dataclass
class StepRecord:
    step: int
    ts: float
    phase: str          # e.g. "navigate", "extract", "act", "write"
    action: str         # human-readable, e.g. "click(640,360)" or "navigate(https://...)"
    frame: str          # filename of the observation after the action, if any
    digest: str = ""
    note: str = ""


@dataclass
class Memory:
    target: str
    run_dir: Path
    findings: list[Finding] = field(default_factory=list)
    visited: list[str] = field(default_factory=list)
    steps: list[StepRecord] = field(default_factory=list)
    plan: list[dict[str, Any]] = field(default_factory=list)   # filled by the planner (step 6)
    started_at: float = field(default_factory=time.time)

    # ---- mutation -------------------------------------------------------------------------

    @property
    def step_no(self) -> int:
        return len(self.steps)

    def add_findings(self, items: Iterable[Finding]) -> int:
        seen = {self._norm(f.fact) for f in self.findings}
        added = 0
        for f in items:
            key = self._norm(f.fact)
            if not key or key in seen:
                continue
            if f.category not in CATEGORIES:
                f.category = "other"
            self.findings.append(f)
            seen.add(key)
            added += 1
        self.save()
        return added

    def mark_visited(self, url: str) -> None:
        n = self._norm_url(url)
        if n and n not in (self._norm_url(u) for u in self.visited):
            self.visited.append(url)
            self.save()

    def has_visited(self, url: str) -> bool:
        n = self._norm_url(url)
        return any(self._norm_url(u) == n for u in self.visited)

    def log_step(self, phase: str, action: str, *, frame: str = "", digest: str = "", note: str = "") -> StepRecord:
        rec = StepRecord(step=self.step_no + 1, ts=time.time(), phase=phase, action=action, frame=frame, digest=digest, note=note)
        self.steps.append(rec)
        self.save()
        return rec

    # ---- views for the brain ----------------------------------------------------------------

    def sources(self) -> list[str]:
        """Stable numbering for citations: [1], [2], ... in order of first appearance."""
        out: list[str] = []
        for f in self.findings:
            if f.source_url not in out:
                out.append(f.source_url)
        return out

    def summary(self, max_chars: int = 6000) -> str:
        """What the brain sees as 'working memory'. Grouped by category, cited by source number."""
        if not self.findings:
            return "(no findings yet)"
        src = self.sources()
        lines: list[str] = []
        for cat in CATEGORIES:
            items = [f for f in self.findings if f.category == cat]
            if not items:
                continue
            lines.append(f"## {cat}")
            for f in items:
                lines.append(f"- {f.fact} [{src.index(f.source_url) + 1}] ({f.confidence})")
        lines.append("## sources")
        lines += [f"[{i + 1}] {u}" for i, u in enumerate(src)]
        text = "\n".join(lines)
        return text if len(text) <= max_chars else text[: max_chars - 20] + "\n...(truncated)"

    def recent_actions(self, n: int = 8) -> list[str]:
        return [f"{s.step}. {s.phase}: {s.action}" + (f" -> {s.note}" if s.note else "") for s in self.steps[-n:]]

    # ---- persistence ------------------------------------------------------------------------

    @property
    def path(self) -> Path:
        return self.run_dir / "checkpoint.json"

    def save(self) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        data = {
            "target": self.target,
            "started_at": self.started_at,
            "findings": [asdict(f) for f in self.findings],
            "visited": self.visited,
            "steps": [asdict(s) for s in self.steps],
            "plan": self.plan,
        }
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.path)  # atomic on Windows and POSIX

    @classmethod
    def load(cls, run_dir: Path) -> "Memory":
        data = json.loads((run_dir / "checkpoint.json").read_text(encoding="utf-8"))
        m = cls(target=data["target"], run_dir=run_dir, started_at=data.get("started_at", time.time()))
        m.findings = [Finding(**f) for f in data.get("findings", [])]
        m.visited = list(data.get("visited", []))
        m.steps = [StepRecord(**s) for s in data.get("steps", [])]
        m.plan = list(data.get("plan", []))
        return m

    @classmethod
    def load_or_new(cls, run_dir: Path, target: str) -> "Memory":
        if (run_dir / "checkpoint.json").exists():
            m = cls.load(run_dir)
            if m.target == target:
                return m
        return cls(target=target, run_dir=run_dir)

    # ---- helpers ----------------------------------------------------------------------------

    @staticmethod
    def _norm(text: str) -> str:
        return " ".join(text.lower().split()).rstrip(".")

    @staticmethod
    def _norm_url(url: str) -> str:
        u = url.strip().lower().rstrip("/")
        for p in ("https://", "http://"):
            if u.startswith(p):
                u = u[len(p):]
        return u[4:] if u.startswith("www.") else u