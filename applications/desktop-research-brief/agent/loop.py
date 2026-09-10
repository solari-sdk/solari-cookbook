"""The agent loop: observe -> reason (with memory) -> act -> update memory -> check termination.

Reliability mechanisms, each mapped to the failure it addresses:
- global action budget         -> runaway loops / cost blowups
- per-task exception isolation -> one dead site cannot kill the run
- malformed-action feedback    -> schema drift becomes a retry with an error message, not a dead task
- stall detection (digest)     -> clicks that do nothing; the brain is told, then the task is abandoned
- scroll cap                   -> the brain cannot oscillate up/down instead of committing to a click
- URL ground truth (omnibox)   -> the model's 'done' is verified, never trusted
- visited set                  -> no blind re-fetching of pages already read
- honest bookkeeping           -> a source blocked by captcha/login/cert warning is 'failed', not 'done'
- checkpoint on every mutation -> a crash or Ctrl+C resumes at the next pending task

The VM itself is not resumable across processes (a new run gets a fresh desktop); memory is.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

from .actuator import Actuator
from .brain import Action, Brain
from .browser import Browser, ddg_url
from .config import SCREEN_H, SCREEN_W
from .memory import CATEGORIES, Memory
from .perception import Observation
from .planner import Task, load_tasks, make_plan, next_task, update_task
from .session import log

SEARCH_GOAL = """You are on a DuckDuckGo results page for the query: {query}
Research goal for this task: {goal}
Open the single most relevant organic result. Skip anything labelled 'Ad'. Skip these already-read pages: {visited}
Prefer primary sources (the company's own pages, GitHub, LinkedIn, CrunchBase, arXiv, reputable news) over aggregators.
If a cookie/privacy prompt covers the results, dismiss it first.
If a relevant result is visible NOW, click its title link NOW; do not scroll to look for something better.
Once the target page is visibly loaded, respond 'done'. If no result is relevant, respond 'fail'."""

SCROLL_CAP_NOTE = "You have already scrolled twice. Scrolling is no longer allowed: click the best visible result title, or respond 'fail'."

DISMISS_GOAL = """Something is covering the page content: {obstacle}
If it is a cookie banner, newsletter popup, or sign-in prompt WITH a close/X/'not now'/'continue without' option:
dismiss it (click that option, or press Escape), then respond 'done'.
If it is a CAPTCHA, a certificate/SSL warning, or a login wall with no way to see content without logging in:
do NOT interact with it. Respond 'fail'. These are hard limits.
If nothing is actually blocking the content, respond 'done' immediately."""

BLOCKED_MARKERS = ("captcha", "verify you are human", "cloudflare", "certificate", "ssl", "err_cert", "login wall", "sign in to view", "log in to view", "paywall")


class BudgetExhausted(RuntimeError):
    pass


@dataclass
class RunConfig:
    target: str
    homepage: str
    max_actions: int = 90        # global budget: every desktop action and every model decision counts
    max_task_actions: int = 6    # decide() steps allowed to get from results page to a source page
    max_tasks: int | None = None # cap for cheap test runs; None = whole plan


def _blocked(obstacle: str) -> bool:
    o = obstacle.lower()
    return any(m in o for m in BLOCKED_MARKERS)


class ResearchAgent:
    def __init__(self, desktop, brain: Brain, mem: Memory, cfg: RunConfig, out_dir: Path) -> None:
        self.desktop = desktop
        self.brain = brain
        self.mem = mem
        self.cfg = cfg
        self.act = Actuator(desktop, SCREEN_W, SCREEN_H, out_dir=out_dir)
        self.browser = Browser(desktop, self.act, brain)
        self.actions = 0
        self.t0 = time.time()

    # ---- bookkeeping ------------------------------------------------------------------------

    def _spend(self, n: int = 1) -> None:
        self.actions += n
        if self.actions > self.cfg.max_actions:
            raise BudgetExhausted(f"action budget {self.cfg.max_actions} exhausted")

    def _record(self, phase: str, action: str, obs: Observation | None = None, note: str = "") -> None:
        self.mem.log_step(phase, action, frame=self.act.last_frame, digest=obs.digest if obs else "", note=note)

    async def _decide(self, obs: Observation, goal: str, history: list[str], memory: str) -> Action:
        """decide() with one retry on a malformed action. The error text goes into history so the
        model sees exactly what to fix. Two malformed actions in a row -> raise (task fails)."""
        for attempt in range(2):
            self._spend()
            try:
                return await self.brain.decide(obs, goal, memory=memory, history=history)
            except ValueError as e:
                log(f"  malformed action ({e}); asking again")
                history.append(f"YOUR LAST ACTION WAS REJECTED: {e}. Return x and y as two separate integers.")
                if attempt == 1:
                    raise
        raise RuntimeError("unreachable")

    # ---- top level --------------------------------------------------------------------------

    async def run(self) -> Memory:
        mem, cfg = self.mem, self.cfg
        obs = await self.browser.launch(cfg.homepage)
        self._spend()
        self._record("navigate", f"launch+navigate({cfg.homepage})", obs)

        if not mem.has_visited(cfg.homepage):
            mem.mark_visited(cfg.homepage)
            await self._read_screens(cfg.homepage, screens=2)
        else:
            log("homepage already in memory (resumed run) - skipping extraction")

        if not mem.plan:
            tasks = await make_plan(self.brain, obs, mem, cfg.homepage)
            self._spend()
            self._record("plan", f"plan({len(tasks)} tasks)", obs)
            for t in tasks:
                log(f"  plan {t.id}. [{t.kind}] {t.value}")
        else:
            log(f"resuming plan: {sum(t['status'] == 'pending' for t in mem.plan)} task(s) pending")

        executed = 0
        while (task := next_task(mem)) is not None:
            if cfg.max_tasks is not None and executed >= cfg.max_tasks:
                log(f"max_tasks={cfg.max_tasks} reached; leaving remaining tasks pending for resume")
                break
            log(f"--- task {task.id} [{task.kind}] {task.value}")
            try:
                await self._execute(task)
            except BudgetExhausted as e:
                update_task(mem, task.id, "skipped", str(e))
                log(f"STOP: {e}")
                break
            except Exception as e:  # noqa: BLE001 - isolation: log, mark, move on
                update_task(mem, task.id, "failed", f"{type(e).__name__}: {e}"[:200])
                log(f"task {task.id} FAILED: {type(e).__name__}: {e}")
            executed += 1

        self._print_summary()
        return mem

    # ---- task execution ---------------------------------------------------------------------

    def _finish(self, task: Task, url: str, new_findings: int, obstacle: str) -> None:
        """Honest status: a blocked or empty source is a failure, not a success with zero findings."""
        if new_findings > 0:
            update_task(self.mem, task.id, "done", f"{url} -> {new_findings} new findings")
        elif obstacle:
            update_task(self.mem, task.id, "failed", f"{url} blocked: {obstacle[:120]}")
        else:
            update_task(self.mem, task.id, "failed", f"{url} -> no new findings")

    async def _execute(self, task: Task) -> None:
        mem = self.mem
        if task.kind == "url":
            url = task.value
            if mem.has_visited(url):
                update_task(mem, task.id, "done", "already visited")
                return
            obs = await self.browser.navigate(url)
            self._spend()
            self._record("navigate", f"navigate({url})", obs)
            mem.mark_visited(url)
            n, obstacle = await self._read_screens(url, task.max_screens)
            self._finish(task, url, n, obstacle)
            return

        # search task: results page -> brain picks a result -> URL verified -> read it
        obs = await self.browser.navigate(ddg_url(task.value))
        self._spend()
        self._record("navigate", f"search({task.value})", obs)
        url = await self._choose_result(task, obs)
        if not url:
            update_task(mem, task.id, "failed", "no result opened")
            return
        if mem.has_visited(url):
            update_task(mem, task.id, "done", f"{url} already visited")
            log(f"result {url} already in memory - not re-reading")
            return
        mem.mark_visited(url)
        n, obstacle = await self._read_screens(url, task.max_screens)
        self._finish(task, url, n, obstacle)

    async def _choose_result(self, task: Task, obs: Observation) -> str | None:
        """Agentic sub-loop on the results page. Termination is by URL, not by the model's word."""
        base_goal = SEARCH_GOAL.format(query=task.value, goal=task.goal, visited=", ".join(self.mem.visited[-8:]))
        history: list[str] = []
        stalls = scrolls = 0
        for _ in range(self.cfg.max_task_actions):
            goal = base_goal if scrolls < 2 else base_goal + "\n" + SCROLL_CAP_NOTE
            action = await self._decide(obs, goal, history, self.mem.summary(2500))
            log(f"  brain: {action.describe()} | {action.reasoning[:110]}")
            if action.kind == "fail":
                self._record("decide", "fail", obs, action.summary or "")
                return None
            if action.kind == "done":
                obs = await self.act.wait_settled(timeout_s=12)
                url = await self.browser.current_url()
                if "duckduckgo.com" in url:
                    history.append("done REJECTED: still on the results page; click a result title")
                    continue
                self._record("decide", "done", obs, url)
                return url
            if action.kind == "scroll":
                scrolls += 1
                if scrolls > 2:
                    history.append("scroll REJECTED: scrolling limit reached; click a result or fail")
                    continue
            new_obs = await self.act.perform(action)
            if action.kind == "click":
                new_obs = await self.act.wait_settled(timeout_s=12)  # a click may start a page load
            changed = not new_obs.same_as(obs)
            self._record("act", action.describe(), new_obs, "changed" if changed else "NO CHANGE")
            history.append(f"{action.describe()} -> {'screen changed' if changed else 'NO VISIBLE CHANGE'}")
            stalls = 0 if changed else stalls + 1
            if stalls >= 2:
                log("  two consecutive no-op actions; abandoning this search task")
                return None
            obs = new_obs
            if action.kind == "click":
                url = await self.browser.current_url()
                if url and "duckduckgo.com" not in url:
                    return url  # left the results page: we are on a source. Skip asking the model.
        return None

    async def _read_screens(self, url: str, screens: int) -> tuple[int, str]:
        """Extract findings from up to `screens` screens of the current page.
        Returns (new findings, last obstacle text or '')."""
        mem = self.mem
        obs = self.act.last or await self.act.observe()
        total, screen, dismissed, obstacle = 0, 0, False, ""
        while screen < screens:
            ex = await self.brain.extract(obs, target=mem.target, url=url, memory=mem.summary(4000), step=mem.step_no + 1)
            self._spend()
            added = mem.add_findings(ex.findings)
            total += added
            obstacle = ex.obstacle
            note = f"{len(ex.findings)} found, {added} new, more_below={ex.more_below}" + (f", obstacle={ex.obstacle!r}" if ex.obstacle else "")
            self._record("extract", f"extract({url}#{screen + 1})", obs, note)
            log(f"  extract screen {screen + 1}: {note}")
            if ex.obstacle and _blocked(ex.obstacle):
                log(f"  blocked source ({ex.obstacle[:80]}); not attempting to bypass")
                break
            if ex.obstacle and not dismissed:
                dismissed = True
                obs = await self._dismiss(ex.obstacle, obs)
                continue  # re-read the same screen now that it is (hopefully) clear
            screen += 1
            if not ex.more_below or screen >= screens:
                break
            await self.act.scroll(1)
            self._spend()
            new_obs = await self.act.observe(settle_s=0.8)
            self._record("act", "scroll(+1)", new_obs)
            if new_obs.same_as(obs):
                break  # end of page
            obs = new_obs
        return total, (obstacle if total == 0 else "")

    async def _dismiss(self, obstacle: str, obs: Observation) -> Observation:
        goal = DISMISS_GOAL.format(obstacle=obstacle)
        history: list[str] = []
        for _ in range(2):
            try:
                action = await self._decide(obs, goal, history, "(n/a)")
            except ValueError:
                return obs
            log(f"  dismiss: {action.describe()} | {action.reasoning[:100]}")
            if action.kind in ("done", "fail"):
                return obs
            obs = await self.act.perform(action)
            self._record("act", f"dismiss:{action.describe()}", obs)
        return obs

    # ---- reporting --------------------------------------------------------------------------

    def _print_summary(self) -> None:
        mem = self.mem
        print("\n=== RUN SUMMARY ===")
        for t in load_tasks(mem):
            print(f"  {t.id:2d}. {t.status:7s} [{t.kind}] {t.value}  {('- ' + t.note) if t.note else ''}")
        by_cat = {c: sum(f.category == c for f in mem.findings) for c in CATEGORIES}
        print(f"findings: {len(mem.findings)}  " + "  ".join(f"{c}={n}" for c, n in by_cat.items() if n))
        print(f"sources: {len(mem.sources())}  actions: {self.actions}/{self.cfg.max_actions}  "
              f"model_calls: {self.brain.calls}  elapsed: {time.time() - self.t0:.0f}s")
        print(f"checkpoint: {mem.path}")