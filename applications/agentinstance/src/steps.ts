/**
 * What a task is, the shell each phase of it runs in the sandbox, and the pull
 * request it ends in. No Workers APIs in here, so all of it tests under Node.
 *
 * Nothing secret is ever interpolated here. Tokens, the goal and the repo
 * reach the VM as environment variables and are expanded by the shell inside
 * it, so they never appear in a command line (which every process in the VM
 * can read) or in this Worker's logs.
 */

export type Status = "queued" | "running" | "pr-opened" | "no-changes" | "failed" | "interrupted"

export interface Task {
  id: string
  repo: string
  goal: string
  base?: string
  branch: string
  status: Status
  createdAt: string
  startedAt?: string
  finishedAt?: string
  /** Wall-clock ms per phase, measured inside the Durable Object. */
  phases: Record<string, number>
  /** Where it is right now, for someone polling. */
  step?: string
  pr?: { url: string; number: number }
  sha?: string
  error?: string
  /** The agent's own output, last 20k characters, saved as it streams. */
  output: string
}

/** `owner/name` from `owner/name`, `https://github.com/owner/name(.git)`. */
export function parseRepo(repo: string): { owner: string; name: string } {
  const m = repo.trim().match(/^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  if (!m) throw new Error(`repo must be "owner/name" or a github.com URL (got "${repo}")`)
  return { owner: m[1], name: m[2] }
}

/** One branch per task, so tasks never push over each other. */
export const branchFor = (taskId: string) => `agent/${taskId}`

/** First line of the goal, trimmed to what GitHub shows in a PR list. */
export function prTitle(goal: string): string {
  const line = goal.trim().split("\n")[0].trim()
  return line.length > 72 ? `${line.slice(0, 69)}…` : line
}

/**
 * Git reads the token from $GITHUB_TOKEN through a credential helper. The
 * obvious alternative, `https://x-access-token:$TOKEN@github.com/…`, writes the
 * token into `.git/config` and into the argv of every git process.
 */
const GIT_AUTH =
  `git -c credential.helper= ` +
  `-c credential.helper='!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'`

/**
 * Installs Node 22 and Claude Code unless they're already there. On a fresh
 * sandbox this measured about six seconds; on a reused one it's a no-op.
 */
export const TOOLCHAIN = [
  "set -e",
  "if ! command -v claude >/dev/null 2>&1; then",
  "  mkdir -p /opt/node22",
  "  T=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o 'node-v[0-9.]*-linux-x64.tar.gz' | head -1)",
  "  curl -fsSL https://nodejs.org/dist/latest-v22.x/$T | tar -xz -C /opt/node22 --strip-components=1",
  "  for b in node npm npx; do ln -sf /opt/node22/bin/$b /usr/local/bin/$b; done",
  "  npm install -g --silent --prefix /opt/node22 @anthropic-ai/claude-code >/dev/null",
  "  ln -sf /opt/node22/bin/claude /usr/local/bin/claude",
  "fi",
  // Claude Code refuses to skip permission prompts as root, and the sandbox is
  // the isolation boundary anyway, so the agent runs as an ordinary user.
  "id -u agent >/dev/null 2>&1 || useradd -m agent",
  // Root commits what the agent user edited; without this git refuses a tree
  // owned by someone else ("detected dubious ownership").
  "git config --global --get-all safe.directory | grep -qx '*' || git config --global --add safe.directory '*'",
  "claude --version",
].join("\n")

/**
 * Clone the repo at its default branch (or $BASE) into $DIR, on a new branch.
 *
 * Prints two lines: the branch the PR should target, and the commit the task
 * starts from. The branch is read straight after the clone, while the checkout
 * is still on it — once the task branch exists, HEAD names that instead.
 * `$REMOTE` overrides the GitHub URL; the tests point it at a local repo.
 */
export const CHECKOUT = [
  "set -e",
  'rm -rf "$DIR" && mkdir -p "$(dirname "$DIR")"',
  `${GIT_AUTH} clone -q --depth 50 ` + '${BASE:+--branch "$BASE"} "${REMOTE:-https://github.com/$REPO.git}" "$DIR"',
  'cd "$DIR"',
  "git rev-parse --abbrev-ref HEAD",
  "git rev-parse HEAD",
  'git checkout -q -b "$BRANCH"',
  // The agent user edits the tree; root commits and pushes it afterwards.
  'if id -u agent >/dev/null 2>&1; then chown -R agent "$DIR"; fi',
].join("\n")

/**
 * Run the agent in $DIR as the `agent` user.
 *
 * `$AGENT_COMMAND` replaces Claude Code when set — the tests use it to drive
 * the whole pipeline with a scripted edit, and it's how you'd swap in another
 * CLI. `timeout` is the backstop: a hung CLI would otherwise hold the Durable
 * Object's alarm until the platform kills it, with nothing recorded.
 */
export function agentScript(timeoutSeconds: number): string {
  const inner =
    'cd "$DIR" && if [ -n "$AGENT_COMMAND" ]; then sh -c "$AGENT_COMMAND"; ' +
    'else claude -p "$GOAL" --dangerously-skip-permissions --output-format text; fi'
  // `runuser` keeps the environment (no -l), so the goal and the credential
  // variables arrive; HOME is set because the CLI keeps its config there.
  return `cd "$DIR" && timeout ${timeoutSeconds} runuser -u agent -- env HOME=/home/agent sh -c '${inner}' </dev/null 2>&1`
}

/**
 * Commit whatever the agent left uncommitted, push the branch, print the SHA.
 * Prints nothing when there's nothing to push.
 *
 * "Nothing" means a clean tree *and* HEAD still at $START. Claude Code often
 * commits its own work, which leaves the tree clean with new commits on top;
 * checking the tree alone reported those runs as "no changes" and dropped them.
 */
export const PUBLISH = [
  "set -e",
  'cd "$DIR"',
  'if [ -n "$(git status --porcelain)" ]; then',
  "  git add -A",
  '  git -c user.name="agentinstance" -c user.email="agentinstance@users.noreply.github.com" commit -q -m "$TITLE"',
  "fi",
  // Unchanged is a result, not an error: say nothing and stop.
  'if [ "$(git rev-parse HEAD)" = "$START" ]; then exit 0; fi',
  `${GIT_AUTH} push -q origin "$BRANCH"`,
  "git rev-parse HEAD",
].join("\n")

/** What changed, for the PR body: every commit since $START, not just the last. */
export const DIFFSTAT = 'cd "$DIR" && git diff --stat "$START" HEAD | tail -20'

export function prBody(task: Task, diffstat: string): string {
  const secs = (ms?: number) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`)
  const tail = task.output.trim().split("\n").slice(-60).join("\n")
  return [
    task.goal,
    "",
    "```",
    diffstat.trim() || "(no diff stat)",
    "```",
    "",
    "<details><summary>Agent output (last 60 lines)</summary>",
    "",
    "```",
    tail || "(none)",
    "```",
    "</details>",
    "",
    `| sandbox | toolchain | checkout | agent | push |`,
    `| --- | --- | --- | --- | --- |`,
    `| ${secs(task.phases.sandbox)} | ${secs(task.phases.toolchain)} | ${secs(task.phases.checkout)} | ${secs(task.phases.agent)} | ${secs(task.phases.push)} |`,
    "",
    `Opened by [agentinstance](https://github.com/solari-sdk/solari-cookbook/tree/main/applications/agentinstance), running in a Solari sandbox. Task \`${task.id}\`.`,
  ].join("\n")
}
