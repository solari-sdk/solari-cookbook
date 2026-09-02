import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import test from "node:test"

import type { GitHubIssue } from "./github-api.js"
import type { ReproductionPlan } from "./plan.js"
import {
  type CodexProcessRunner,
  generateReproductionPlan,
  parseCodexPlanOutput,
} from "./planner.js"

const issue: GitHubIssue = {
  title: "Connection error is unclear",
  body: "Calling the example raises an unexpected connection error.",
  state: "open",
  labels: ["bug"],
  htmlUrl: "https://github.com/psf/requests/issues/6102",
  repositoryUrl: "https://github.com/psf/requests",
  number: 6102,
}

const validPlan: ReproductionPlan = {
  issueSummary: "A request produces an unexpected connection error.",
  confidence: "medium",
  assumptions: ["The report applies to the current default branch."],
  setupCommands: ["python -m pip install -e ."],
  reproductionCommands: ["python -m pytest tests/test_requests.py"],
  expectedEvidence: "The targeted test displays the reported connection error.",
  successCriteria: ["The reported error is observed in command output."],
  notes: [],
}

const authenticatedResult = {
  exitCode: 0,
  stdout: "Logged in using ChatGPT\n",
  stderr: "",
}

const multilineHeredocPlan: ReproductionPlan = {
  ...validPlan,
  reproductionCommands: [`python - <<'PY'
print("missing closing delimiter")`],
}

function structuredOutputPath(args: string[]): string {
  const outputIndex = args.indexOf("--output-last-message")
  assert.notEqual(outputIndex, -1)
  const outputPath = args[outputIndex + 1]
  if (!outputPath) {
    throw new Error("Test runner did not receive a structured output path")
  }
  return outputPath
}

test("parses valid structured Codex output", () => {
  assert.deepEqual(parseCodexPlanOutput(JSON.stringify(validPlan)), validPlan)
})

test("rejects malformed structured Codex output", () => {
  assert.throws(() => parseCodexPlanOutput("not json"), /malformed structured output/)
})

test("rejects fragment-style structured output from the live smoke test", () => {
  const fragmentedPlan: ReproductionPlan = {
    ...validPlan,
    reproductionCommands: [
      `cd /work/repo && python - <<'PY'
header = {"nonce": "0123-`,
      `qop": "auth", "algorithm": "MD5"`,
      `assert header is not None
PY`,
      "notes",
      "setupCommands",
    ],
  }

  assert.throws(
    () => parseCodexPlanOutput(JSON.stringify(fragmentedPlan)),
    /multiline command/,
  )
})

test("a valid first plan uses exactly one Codex generation", async () => {
  let generationCount = 0
  const runner: CodexProcessRunner = async (_executable, args, options) => {
    if (args[0] === "login") {
      return authenticatedResult
    }

    generationCount += 1
    assert.equal(args[0], "exec")
    assert.ok(args.includes("read-only"))
    assert.ok(args.includes("--ephemeral"))
    assert.ok(args.includes("--output-schema"))
    assert.match(options.input ?? "", /https:\/\/github\.com\/psf\/requests/)
    assert.match(options.input ?? "", /independently pass sh -n -c/)
    assert.match(options.input ?? "", /exactly one complete shell command on exactly one line/)
    assert.match(options.input ?? "", /Never use heredocs or emit literal newline/)
    assert.match(options.input ?? "", /python3 -c/)

    await writeFile(structuredOutputPath(args), JSON.stringify(validPlan), "utf8")
    return { exitCode: 0, stdout: "", stderr: "" }
  }

  assert.deepEqual(await generateReproductionPlan(issue, { processRunner: runner }), validPlan)
  assert.equal(generationCount, 1)
})

test("an invalid generated plan is retried once and replaced by a valid fresh plan", async () => {
  const generationArgs: string[][] = []
  const generationPrompts: string[] = []
  const runner: CodexProcessRunner = async (_executable, args, options) => {
    if (args[0] === "login") {
      return authenticatedResult
    }

    generationArgs.push([...args])
    generationPrompts.push(options.input ?? "")
    const plan = generationArgs.length === 1 ? multilineHeredocPlan : validPlan
    await writeFile(structuredOutputPath(args), JSON.stringify(plan), "utf8")
    return { exitCode: 0, stdout: "", stderr: "" }
  }

  assert.deepEqual(await generateReproductionPlan(issue, { processRunner: runner }), validPlan)
  assert.equal(generationArgs.length, 2)
  assert.match(generationPrompts[1] ?? "", /Correction required:/)
  assert.match(generationPrompts[1] ?? "", /multiline command/)
  assert.match(generationPrompts[1] ?? "", /entire plan again from scratch/)
  assert.match(generationPrompts[1] ?? "", /Never use heredocs/)

  for (const args of generationArgs) {
    assert.equal(args[0], "exec")
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only")
    assert.ok(args.includes("--ephemeral"))
    assert.ok(args.includes("--output-schema"))
    assert.ok(args.includes("--output-last-message"))
  }
})

test("two invalid generated plans fail after exactly two Codex generations", async () => {
  let generationCount = 0
  const runner: CodexProcessRunner = async (_executable, args) => {
    if (args[0] === "login") {
      return authenticatedResult
    }

    generationCount += 1
    await writeFile(structuredOutputPath(args), JSON.stringify(multilineHeredocPlan), "utf8")
    return { exitCode: 0, stdout: "", stderr: "" }
  }

  await assert.rejects(
    generateReproductionPlan(issue, { processRunner: runner }),
    /retry also produced an invalid reproduction plan.*multiline command/,
  )
  assert.equal(generationCount, 2)
})

test("malformed structured output is not retried", async () => {
  let generationCount = 0
  const runner: CodexProcessRunner = async (_executable, args) => {
    if (args[0] === "login") {
      return authenticatedResult
    }

    generationCount += 1
    await writeFile(structuredOutputPath(args), "not json", "utf8")
    return { exitCode: 0, stdout: "", stderr: "" }
  }

  await assert.rejects(
    generateReproductionPlan(issue, { processRunner: runner }),
    /malformed structured output/,
  )
  assert.equal(generationCount, 1)
})

test("reports a nonzero Codex process exit", async () => {
  let generationCount = 0
  const runner: CodexProcessRunner = async (_executable, args) => {
    if (args[0] === "login") {
      return authenticatedResult
    }
    generationCount += 1
    return { exitCode: 7, stdout: "", stderr: "planning failed" }
  }

  await assert.rejects(
    generateReproductionPlan(issue, { processRunner: runner }),
    /Codex planning failed with exit code 7/,
  )
  assert.equal(generationCount, 1)
})

test("reports an unavailable Codex executable", async () => {
  const runner: CodexProcessRunner = async () => {
    throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })
  }

  await assert.rejects(
    generateReproductionPlan(issue, { processRunner: runner }),
    /Codex CLI is unavailable/,
  )
})

test("rejects Codex authentication that is not backed by ChatGPT", async () => {
  let runnerInvocations = 0
  const runner: CodexProcessRunner = async () => {
    runnerInvocations += 1
    return {
      exitCode: 0,
      stdout: "Logged in using an API key\n",
      stderr: "",
    }
  }

  await assert.rejects(
    generateReproductionPlan(issue, { processRunner: runner }),
    /authenticated through ChatGPT/,
  )
  assert.equal(runnerInvocations, 1)
})
