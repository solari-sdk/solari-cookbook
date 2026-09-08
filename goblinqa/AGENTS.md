# GoblinQA Codex Instructions

## Required context

Before major architectural or implementation work:

1. Read `README.md` completely.
2. Read `PROJECT_CONTEXT.md` completely.
3. Inspect the relevant official Solari cookbook examples in `../examples/`.
4. Verify current Solari SDK behavior before inventing abstractions or copying old examples.

Prefer current official SDK patterns and the smallest implementation that proves the active milestone.

## Runtime boundary

- Solari MCP is development and debugging tooling for Codex.
- GoblinQA production code must not depend on MCP.
- GoblinQA runtime uses `@solarisdk/browser` directly.
- Fix Goblin later uses the standalone `@solarisdk/sandbox` package directly.
- Do not blindly copy older aggregate `@solarisdk/sdk` imports from cookbook examples.
- Do not add `playwright-core` unless manual CDP control is actually required; prefer `solari.launch({ recording: true })` for the simplest browser path.

## Milestone order

Build incrementally and do not skip ahead:

1. **Milestone 0:** one recorded browser through the runtime SDK.
2. **Milestone 1:** one autonomous Goblin.
3. **Milestone 2:** three behavioral personas.
4. **Milestone 3:** structured evidence and replay.
5. **Milestone 4:** issue clustering.
6. **Milestone 5:** five Goblins.
7. **Milestone 6:** scale toward 20 Goblins.
8. **Milestone 7:** Fix Goblin with Solari Sandbox.
9. **Milestone 8:** rerun the same failing Goblin for before/after verification.

Do not claim a milestone or feature works unless it has been run against the real relevant system.

## Resource limits

Browser sessions:

- normal debugging: 1 Goblin;
- feature testing: maximum 3 Goblins;
- integration testing: maximum 5 Goblins;
- 20 Goblins only for deliberate, authorized demonstration or stress runs.

Fix Goblin sandboxes:

- 1 sandbox by default;
- maximum 2 concurrent sandboxes;
- kill completed sandboxes as soon as they are no longer needed.

## SDK lifecycle rules

### Browser

- Use current official Solari Browser SDK patterns.
- Enable recording explicitly whenever replay evidence is required.
- Always close the browser in cleanup, including failure paths.
- Retrieve replay evidence only after session completion or release.
- Replay processing is asynchronous; use bounded retry rather than an unbounded wait.
- Always close the TypeScript Solari client with `await solari.close()`.
- Never leave a browser session holding a concurrency slot.

### Sandbox

- Use current standalone `@solarisdk/sandbox` patterns.
- Use `try/finally` around every remote sandbox lifecycle.
- Always destroy the remote VM with `await sandbox.kill()` when finished.
- `sandbox.close()` only closes the local control channel and is not sufficient cleanup.
- Commands are not shell-interpreted; pass the binary and `args` separately unless an explicit shell is required.

## Safety and secrets

- Test only websites the user owns or has explicit permission to test.
- Do not perform load flooding, DDoS behavior, credential attacks, exploitation, spam, destructive actions, real purchases, or unbounded crawling.
- Never commit `SOLARI_API_KEY`, LLM API keys, credentials, tokens, or other secrets.
- Use environment variables and committed example files with empty values only.

## Scope control

Do not build until required by the active milestone:

- authentication;
- billing;
- teams or organizations;
- enterprise dashboards;
- CI integrations;
- Chrome extensions;
- GitHub Apps;
- elaborate databases;
- unrelated infrastructure.

Before adding a feature, ask:

> Does this make the core Goblin testing loop more useful, believable, or demonstrable?

If not, do not build it yet.
