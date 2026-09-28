import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { agentScript, CHECKOUT, DIFFSTAT, parseRepo, prBody, prTitle, PUBLISH, type Task } from "../src/steps.ts"

test("parseRepo accepts owner/name and github URLs, rejects the rest", () => {
  assert.deepEqual(parseRepo("octo/hello"), { owner: "octo", name: "hello" })
  assert.deepEqual(parseRepo("https://github.com/octo/hello.git"), { owner: "octo", name: "hello" })
  assert.deepEqual(parseRepo(" https://github.com/octo/hello/ "), { owner: "octo", name: "hello" })
  assert.throws(() => parseRepo("hello"), /owner\/name/)
  assert.throws(() => parseRepo("octo/hello; rm -rf /"), /owner\/name/)
})

test("prTitle is the goal's first line, capped for the PR list", () => {
  assert.equal(prTitle("Fix slugify\n\nMore detail here"), "Fix slugify")
  const long = prTitle("x".repeat(100))
  assert.equal(long.length, 70)
  assert.ok(long.endsWith("…"))
})

test("the agent step is bounded by a timeout", () => {
  assert.match(agentScript(600), /timeout 600 runuser -u agent/)
})

/** A repo cloned from a local bare "GitHub", on the task's branch. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "agentinstance-"))
  const origin = join(root, "origin.git")
  const dir = join(root, "work")
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
  git(root, "init", "-q", "--bare", "-b", "main", origin)
  git(root, "clone", "-q", origin, dir)
  writeFileSync(join(dir, "a.txt"), "one\n")
  git(dir, "add", ".")
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
  git(dir, "push", "-q", "origin", "main")
  const start = git(dir, "rev-parse", "HEAD")
  git(dir, "checkout", "-q", "-b", "agent/abc123")
  return { root, origin, dir, git, start }
}

function sh(script: string, env: Record<string, string>) {
  return spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } })
}

function publish(dir: string, start: string, extraEnv: Record<string, string> = {}) {
  return sh(PUBLISH, { DIR: dir, START: start, BRANCH: "agent/abc123", TITLE: "Fix a", GITHUB_TOKEN: "ghp_SECRET_VALUE", ...extraEnv })
}

test("PUBLISH with nothing changed prints nothing and pushes nothing", () => {
  const { origin, dir, git, start } = workspace()
  const r = publish(dir, start)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), "")
  assert.equal(git(origin, "branch", "--list", "agent/abc123"), "")
})

test("PUBLISH commits as the agent, pushes the task branch, prints the SHA", () => {
  const { origin, dir, git, start } = workspace()
  writeFileSync(join(dir, "a.txt"), "two\n")
  const r = publish(dir, start)
  assert.equal(r.status, 0, r.stderr)
  const sha = r.stdout.trim()
  assert.match(sha, /^[0-9a-f]{40}$/)
  assert.equal(git(origin, "rev-parse", "agent/abc123"), sha)
  assert.equal(git(origin, "log", "-1", "--format=%an|%s", "agent/abc123"), "agentinstance|Fix a")
})

test("the GitHub token never appears in a git command line", () => {
  // A `git` shim first on PATH that records its argv, then runs the real one.
  const { root, dir, start } = workspace()
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
  const log = join(root, "argv.log")
  const shim = join(root, "bin")
  execFileSync("mkdir", ["-p", shim])
  writeFileSync(join(shim, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${realGit}" "$@"\n`)
  chmodSync(join(shim, "git"), 0o755)
  writeFileSync(join(dir, "a.txt"), "three\n")
  const r = publish(dir, start, { PATH: `${shim}:${process.env.PATH}` })
  assert.equal(r.status, 0, r.stderr)
  const argv = readFileSync(log, "utf8")
  assert.match(argv, /push -q origin agent\/abc123/)
  assert.ok(!argv.includes("ghp_SECRET_VALUE"), "token leaked into argv")
})

test("PUBLISH pushes work the agent committed itself, leaving the tree clean", () => {
  // Claude Code often commits on its own. A clean tree is not "no changes".
  const { origin, dir, git, start } = workspace()
  writeFileSync(join(dir, "a.txt"), "by the agent\n")
  git(dir, "-c", "user.name=claude", "-c", "user.email=c@c", "commit", "-q", "-am", "agent's own commit")
  const r = publish(dir, start)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), git(dir, "rev-parse", "HEAD"))
  assert.equal(git(origin, "log", "-1", "--format=%an|%s", "agent/abc123"), "claude|agent's own commit")
})

test("PUBLISH commits leftovers on top of the agent's own commits", () => {
  const { origin, dir, git, start } = workspace()
  writeFileSync(join(dir, "a.txt"), "committed\n")
  git(dir, "-c", "user.name=claude", "-c", "user.email=c@c", "commit", "-q", "-am", "part one")
  writeFileSync(join(dir, "b.txt"), "left uncommitted\n")
  assert.equal(publish(dir, start).status, 0)
  assert.equal(git(origin, "log", "--format=%s", `${start}..agent/abc123`), "Fix a\npart one")
})

test("CHECKOUT reports the repo's real default branch and the starting commit", () => {
  // A default branch that isn't "main", to catch anything that guesses.
  const { root, origin, git } = workspace()
  git(root, "--git-dir", origin, "branch", "-m", "main", "trunk")
  git(root, "--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/trunk")
  const dir = join(root, "task")
  const r = sh(CHECKOUT, { DIR: dir, REMOTE: origin, REPO: "x/y", BRANCH: "agent/t1", BASE: "" })
  assert.equal(r.status, 0, r.stderr)
  const [branch, start] = r.stdout.trim().split("\n")
  assert.equal(branch, "trunk")
  assert.equal(start, git(root, "--git-dir", origin, "rev-parse", "trunk"))
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "agent/t1")
})

test("CHECKOUT with a base branch starts from that branch", () => {
  const { root, origin, dir, git } = workspace()
  git(dir, "checkout", "-q", "-b", "release")
  writeFileSync(join(dir, "r.txt"), "release\n")
  git(dir, "add", ".")
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "release only")
  git(dir, "push", "-q", "origin", "release")
  const r = sh(CHECKOUT, { DIR: join(root, "task"), REMOTE: origin, REPO: "x/y", BRANCH: "agent/t2", BASE: "release" })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim().split("\n")[0], "release")
})

test("DIFFSTAT covers every commit since the start, not just the last", () => {
  const { dir, git, start } = workspace()
  writeFileSync(join(dir, "a.txt"), "changed\n")
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "one")
  writeFileSync(join(dir, "b.txt"), "new\n")
  git(dir, "add", ".")
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "two")
  const out = sh(DIFFSTAT, { DIR: dir, START: start }).stdout
  assert.match(out, /a\.txt/)
  assert.match(out, /b\.txt/)
  assert.match(out, /2 files changed/)
})

test("prBody carries the goal, diff stat, output tail and timings", () => {
  const task: Task = {
    id: "abc123",
    repo: "octo/hello",
    goal: "Fix slugify",
    branch: "agent/abc123",
    status: "running",
    createdAt: "",
    phases: { sandbox: 1500, toolchain: 6200, checkout: 900, agent: 42000, push: 1700 },
    output: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
  }
  const body = prBody(task, " slugify.js | 2 +-\n")
  assert.ok(body.startsWith("Fix slugify"))
  assert.match(body, /slugify\.js \| 2 \+-/)
  assert.match(body, /line 99/)
  assert.ok(!body.includes("line 39\n"), "only the last 60 lines")
  assert.match(body, /\| 1\.5s \| 6\.2s \| 0\.9s \| 42\.0s \| 1\.7s \|/)
})
