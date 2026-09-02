"""Planner: target + homepage screenshot + memory -> ordered list of research Tasks.

Model proposes, code guarantees. The model sees the site's navigation and proposes subpages plus
external searches; then required_tasks() appends any mandatory angle it forgot (funding, GitHub,
LinkedIn, jobs, papers, news). Result is deterministic in coverage, adaptive in specifics.

Tasks are stored in memory.plan (plain dicts) so a resumed run continues where it stopped.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date
from typing import Any

from .brain import Brain
from .memory import Memory
from .perception import Observation

MAX_TASKS = 9

PLAN_TOOL: dict[str, Any] = {
    "name": "research_plan",
    "description": "Propose an ordered research plan.",
    "input_schema": {
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": ["url", "search"]},
                        "value": {"type": "string", "description": "Full URL for kind=url; search query for kind=search."},
                        "goal": {"type": "string", "description": "What specifically to learn from this source."},
                        "max_screens": {"type": "integer", "description": "How many screens to read (1-4)."},
                    },
                    "required": ["kind", "value", "goal", "max_screens"],
                },
            },
            "rationale": {"type": "string"},
        },
        "required": ["tasks"],
    },
}

PLAN_TEMPLATE = """You are planning web research on: {target}
Homepage (already read): {homepage}
Today's date: {today}. 'Recent' means the last 12 months; put the current year in news queries, not older years.

The screenshot shows the homepage. Use its navigation to propose the site's own subpages worth reading
(About, Research, Blog, Careers, Team, Publications, etc.) as kind=url with full URLs derived from {homepage}.
Then propose external searches (kind=search, DuckDuckGo queries) to cover: funding and investors, GitHub
presence, LinkedIn company page, job postings and what roles they hire, research papers or technical posts,
recent news. Each task needs a precise goal: what fact-types it should yield.

Constraints:
- 5 to {max_tasks} tasks, most valuable first. Site subpages before external searches.
- Skip low-value pages (Contact, Privacy, Terms) unless nothing better exists.
- Do not propose URLs already visited: {visited}
- Do not invent subpage URLs you cannot see or infer from the navigation.

What is already known:
{memory}"""

REQUIRED_SEARCHES: tuple[tuple[str, str], ...] = (
    ("{t} funding OR raised OR investors", "Funding rounds, amounts, investors, dates."),
    ("{t} github", "Open-source repos, tech stack, activity level."),
    ("{t} linkedin", "Headcount, locations, founders and key hires."),
    ("{t} careers OR jobs OR hiring", "Open roles, seniority, locations, tech mentioned in postings."),
    ("{t} paper OR arxiv OR research", "Publications, technical blog posts, benchmarks."),
    ("{t} news OR announces {year}", "Recent announcements, partnerships, launches with dates."),
)


@dataclass
class Task:
    id: int
    kind: str          # "url" | "search"
    value: str
    goal: str
    max_screens: int = 2
    status: str = "pending"   # pending | done | failed | skipped
    note: str = ""


def _key(kind: str, value: str) -> str:
    return f"{kind}:{' '.join(value.lower().split()).rstrip('/')}"


def required_tasks(target: str) -> list[Task]:
    year = date.today().year
    return [Task(0, "search", q.format(t=target, year=year), goal, 2) for q, goal in REQUIRED_SEARCHES]


async def make_plan(brain: Brain, obs: Observation, mem: Memory, homepage: str) -> list[Task]:
    prompt = PLAN_TEMPLATE.format(
        target=mem.target, homepage=homepage, today=date.today().isoformat(), max_tasks=MAX_TASKS,
        visited=", ".join(mem.visited) or "(none)", memory=mem.summary(3000),
    )
    resp = await brain.call(
        max_tokens=1500,
        tools=[PLAN_TOOL],
        tool_choice={"type": "tool", "name": "research_plan"},
        messages=[{"role": "user", "content": [brain.image_block(obs), {"type": "text", "text": prompt}]}],
    )
    data = brain.tool_input(resp, "research_plan")

    proposed: list[Task] = []
    for t in data.get("tasks", []):
        kind = str(t.get("kind", "")).strip()
        value = str(t.get("value", "")).strip()
        if kind not in ("url", "search") or not value:
            continue
        if kind == "url" and mem.has_visited(value):
            continue
        proposed.append(Task(0, kind, value, str(t.get("goal", "")).strip(), max(1, min(int(t.get("max_screens", 2)), 4))))

    # Guarantee coverage: append any required angle the model omitted, without duplicating.
    seen = {_key(t.kind, t.value) for t in proposed}

    def covers(req: Task) -> bool:
        needle = req.value.lower().replace(mem.target.lower(), "").split(" or ")[0].strip()
        return any(t.kind == "search" and needle in t.value.lower() for t in proposed)

    for req in required_tasks(mem.target):
        if _key(req.kind, req.value) not in seen and not covers(req):
            proposed.append(req)

    tasks = [Task(i + 1, t.kind, t.value, t.goal, t.max_screens) for i, t in enumerate(proposed[:MAX_TASKS])]
    mem.plan = [asdict(t) for t in tasks]
    mem.save()
    return tasks


def load_tasks(mem: Memory) -> list[Task]:
    return [Task(**t) for t in mem.plan]


def next_task(mem: Memory) -> Task | None:
    for t in load_tasks(mem):
        if t.status == "pending":
            return t
    return None


def update_task(mem: Memory, task_id: int, status: str, note: str = "") -> None:
    for t in mem.plan:
        if t["id"] == task_id:
            t["status"] = status
            t["note"] = note
    mem.save()