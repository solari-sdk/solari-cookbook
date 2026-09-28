# agentinstance on Solari (TypeScript, Cloudflare Workers)

**File a task, close the laptop, get a pull request.**

Each agent is a Cloudflare Durable Object that owns one Solari sandbox. You
send it a repo and a goal. It answers at once, then works on its own: it clones
the repo into its sandbox, runs Claude Code on the goal, commits what changed,
pushes a branch, and opens a pull request. Nothing runs on your machine, and
nothing needs to stay connected.

```
 you ──POST /agents/alice/tasks──▶ Worker ──▶ Durable Object "alice"      Solari sandbox
 ◀── 202 {id, status: "queued"} ──┘            │ stores the task             │
                                               │ sets an alarm               │
 (close the laptop)                            │                             │
                                               │ alarm fires ──────────────▶ │ install Claude Code (first time)
                                               │                             │ git clone → branch agent/<id>
                                               │   output saved as it ◀───── │ claude -p "<goal>"
                                               │   streams                   │ git commit, push
                                               │ opens the PR on GitHub      │
 GET /agents/alice/tasks/<id> ──▶ {status: "pr-opened", pr: {url}}
```

The two halves each do what they're good at. A Durable Object is one named,
durable, always-addressable thing, with its own storage and alarms. It can't run
a process. A Solari sandbox is a real Linux VM that boots in about a second.
It's no place to keep state. Put the agent's memory in the first and its hands
in the second.

## What it needs

| Secret | For |
| --- | --- |
| `SOLARI_API_KEY` | the sandbox ([console.getsolari.com](https://console.getsolari.com)) |
| `GITHUB_TOKEN` | cloning, pushing and opening PRs: a fine-grained token with *Contents* and *Pull requests* write on the repos you'll use |
| `CLAUDE_CODE_OAUTH_TOKEN` *or* `ANTHROPIC_API_KEY` | Claude Code inside the sandbox. `claude setup-token` bills your Claude subscription. An API key bills API credit. |
| `AGENT_TOKEN` | a bearer token of your choosing. Whoever has it can spend everything above, so every request must send it. |

Missing agent credentials fail the task with a message that says so. They
don't fail silently.

## Run it

```bash
cd applications/agentinstance
npm install
cp .dev.vars.example .dev.vars      # fill in the four secrets
npm start                           # wrangler dev on http://localhost:8787
```

```bash
TOKEN=...   # your AGENT_TOKEN
curl -X POST localhost:8787/agents/alice/tasks \
  -H "authorization: Bearer $TOKEN" \
  -d '{"repo": "you/your-repo", "goal": "Fix slugify so every test in slugify.test.js passes."}'
# → 202 {"id":"a6e93c21","status":"queued","branch":"agent/a6e93c21",…}

curl localhost:8787/agents/alice/tasks/a6e93c21 -H "authorization: Bearer $TOKEN"
# → {"status":"running","step":"agent","output":"…the agent's output so far…"}
# → {"status":"pr-opened","pr":{"url":"https://github.com/you/your-repo/pull/1"},"phases":{…}}
```

`npm run deploy` puts it on your workers.dev subdomain. Set each secret with
`wrangler secret put`.

| Route | |
| --- | --- |
| `POST /agents/<name>/tasks` | `{"repo", "goal", "base"?}` → 202 with the queued task |
| `GET /agents/<name>` | every task this agent has had |
| `GET /agents/<name>/tasks/<id>` | one task, with the agent's output so far |
| `DELETE /agents/<name>/sandbox` | kill the agent's sandbox now instead of at its idle timeout |

## A real run

Against [a small repo](https://github.com/shashank-100/always-on-agent-playground)
whose `slugify` fails 3 of 4 tests. Claude Code did the fix, in a fresh Solari
sandbox. The request returned at once, and 24 seconds later the pull request
was open:

```
  4s  running toolchain
  8s  running checkout
 12s  running agent
 24s  pr-opened  https://github.com/shashank-100/always-on-agent-playground/pull/4
```

| sandbox | toolchain | checkout | agent (Claude Code) | push | pull request |
| --- | --- | --- | --- | --- | --- |
| 1.2s | 6.1s | 0.8s | 12.8s | 1.7s | 1.3s |

Claude's change, from [the PR](https://github.com/shashank-100/always-on-agent-playground/pull/4/files):

```diff
-  return title.toLowerCase().replace(" ", "-")
+  return title
+    .toLowerCase()
+    .replace(/[^a-z0-9\s-]/g, "")
+    .trim()
+    .replace(/[\s-]+/g, "-")
+    .replace(/^-+|-+$/g, "")
```

and its closing line: *"All 4 tests pass in slugify.test.js."*

The toolchain step is the first task on a new sandbox installing Node 22 and
Claude Code. Later tasks on the same sandbox reuse them.

To test the pipeline without spending model credit, set `AGENT_COMMAND` to any
shell command. It runs in place of Claude Code, and everything else (the
sandbox, the clone, the push, the PR) runs for real.

## How it holds up

- **The caller can leave.** Filing a task only stores it and sets an alarm.
  The alarm does the work, and a thrown alarm would be retried, so `execute`
  never throws: every task ends as `pr-opened`, `no-changes` or `failed`, with
  the reason.
- **A crash can't open two PRs.** An alarm that finds a task still `running`
  knows the run before it died partway. Its branch may already be pushed. It's
  marked `interrupted`, not run again. A task filed *while* another runs sets a
  fresh alarm, and an in-memory `busy` flag stops that alarm from mistaking the
  live task for a dead one. The flag only resets when the object restarts,
  which is exactly the case where the task really was interrupted.
- **Sandboxes come and go.** The sandbox id is kept in the object's storage.
  A reattach is proven with a no-op command, because a killed sandbox still
  looks up and connects. A stale in-memory handle is retried on a fresh
  sandbox only if the old one is gone, so a command never runs twice.
  If the sandbox is lost mid-task, the task fails saying so instead of
  running the next step on a blank machine. See [`src/sandbox.ts`](src/sandbox.ts).
- **A full plan waits instead of failing.** When every sandbox the plan allows
  is busy (a 429 `ConcurrencyLimitExceeded`; the free tier runs one), the task
  goes back in the queue and the alarm tries again in a minute.
- **Secrets stay out of command lines.** Tokens, the goal and the repo reach
  the VM as environment variables. Git reads the token through a credential
  helper, not a `https://token@github.com` URL, which would land in
  `.git/config` and every git process's argv. A test runs the real push
  through a `git` shim and checks the token is in no argv.
- **A hung CLI can't hold the alarm forever.** The agent runs under
  `timeout 600`. Exit 124 is reported as a timeout.

## Gotchas this encodes

- **`Illegal invocation` from the SDK on Workers.** Pass
  `fetch: (input, init) => fetch(input, init)` to `SolariClient`.
- **Sandbox commands start without `$HOME`.** `git config --global` fails with
  `fatal: $HOME not set`. Every command here gets `HOME=/root`, and the agent
  gets `HOME=/home/agent`.
- **Claude Code won't skip permission prompts as root.** The sandbox is the
  isolation boundary, so the agent runs as an ordinary `agent` user via
  `runuser`. Root commits afterwards, which needs `safe.directory`.
- **Custom templates need a paid plan** (`402 FeatureRequiresPlan`), so the
  toolchain is installed on first use instead of baked into an image. That's
  six seconds, once per sandbox.
- **Commands are exec'd, not shell-interpreted.** Everything goes through
  `sh -c`.

## Limits

- One task at a time per agent. A second agent needs a second sandbox slot on
  your plan.
- Public GitHub only, through a token you provide. No GitHub App, no webhooks.
- The alarm has Cloudflare's 15-minute limit. The agent's own timeout is 10.

## Tests

```bash
npm test          # 14 tests, no API keys needed
npm run typecheck
```

They run the real shell steps against real git (a local repo standing in for
GitHub): the clone reports the true default branch, a push includes commits the
agent made itself, a clean tree pushes nothing, the diff covers every commit,
and the GitHub token appears in no command line. A fake Solari client covers the
lost-sandbox cases.
