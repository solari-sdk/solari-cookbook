# Upstream port — `openai/openai-agents-python`

`0001-add-solari-sandbox-provider.patch` adds Solari as a hosted sandbox provider
to the Agents SDK, in the repo's own layout (the cookbook module is the dev source;
this is the port ready to submit upstream).

> **Base + staleness:** created **2026-09-15**, applied cleanly (`git apply --check`)
> onto **`openai/openai-agents-python@main` = commit `fbf59a4`**. Their `main` moves;
> the further it has advanced past `fbf59a4`, the more likely `git am` needs a rebase.
> Re-check with `git apply --check` against a fresh clone before relying on it.
>
> **Status (2026-09-21): DEFERRED, not declined.** James has deprioritized the OpenAI
> Agents SDK work; no fork exists and no upstream PR should be opened yet. The
> integration is proven end-to-end against real prod Solari sandboxes (the hard part) —
> resume here when priorities allow.

## What it changes
- `src/agents/extensions/sandbox/solari/{__init__,sandbox}.py` — the provider
  (relative imports, matching Blaxel/E2B).
- `src/agents/extensions/sandbox/__init__.py` — registration (try-import + `__all__`).
- `pyproject.toml` — `openai-agents[solari]` extra + mypy override.
- `docs/sandbox/clients.md` — platforms-table row.
- `examples/sandbox/extensions/solari_runner.py` — runnable example.

## Open the PR
Pushing requires a fork (no direct push to `openai/*`):

```bash
git clone https://github.com/<you>/openai-agents-python   # your fork
cd openai-agents-python
git checkout -b add-solari-sandbox-provider
git am /path/to/0001-add-solari-sandbox-provider.patch     # or: git apply
git push -u origin add-solari-sandbox-provider
# open the PR against openai/openai-agents-python — body is in ../PR_DRAFT.md
```

## Before submitting (checklist)
- [ ] Publish `solari-sandbox` with the PTY `args` field public (the port opens the
      PTY over the control channel because the current SDK helper omits `args`; a
      public `pty.create(..., args=...)` lets it drop that internal call).
- [ ] Add repo unit tests mirroring `tests/` for other providers.
- [ ] `make lint` / `make mypy` in the repo.
- [ ] Add a Solari maintainer as CODEOWNER for `extensions/sandbox/solari/`.
