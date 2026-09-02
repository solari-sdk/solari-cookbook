import assert from "node:assert/strict"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { ReproductionPlan } from "./plan.js"
import { validatePlanCommands } from "./plan.js"

function planWith(command: string): ReproductionPlan {
  return {
    issueSummary: "A test issue",
    confidence: "medium",
    assumptions: [],
    setupCommands: [],
    reproductionCommands: [command],
    expectedEvidence: "The command exposes the reported behavior",
    successCriteria: ["The reported error is observed"],
    notes: [],
  }
}

function planWithCommands(commands: string[]): ReproductionPlan {
  return {
    ...planWith("placeholder"),
    reproductionCommands: commands,
  }
}

test("accepts one valid ordinary command", () => {
  assert.doesNotThrow(() => validatePlanCommands(planWith("python -m pytest tests/test_api.py")))
})

test("accepts one valid python -c reproduction command", () => {
  assert.doesNotThrow(() =>
    validatePlanCommands(planWith(`python3 -c 'print("single line")'`)),
  )
})

test("rejects a multiline command", () => {
  assert.throws(
    () => validatePlanCommands(planWith("python -m pytest tests/test_api.py\nprintf done")),
    /multiline command/,
  )
})

test("rejects a complete multiline heredoc command", () => {
  const command = `python - <<'PY'
print("complete heredoc")
PY`

  assert.throws(() => validatePlanCommands(planWith(command)), /multiline command/)
})

test("rejects a heredoc split across array items", () => {
  const plan = planWithCommands([
    `python - <<'PY'
print("first fragment")`,
    `print("second fragment")
PY`,
  ])

  assert.throws(() => validatePlanCommands(plan), /multiline command/)
})

test("rejects a dangling quote", () => {
  assert.throws(
    () => validatePlanCommands(planWith(`python -c 'print("missing quote")`)),
    /incomplete shell syntax/,
  )
})

test("rejects empty commands and schema-field fragments", () => {
  assert.throws(() => validatePlanCommands(planWith("   ")), /empty command/)
  assert.throws(() => validatePlanCommands(planWith("notes")), /schema-field fragment/)
  assert.throws(() => validatePlanCommands(planWith("reproductionCommands")), /schema-field fragment/)
})

test("syntax validation does not execute substitutions or redirects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repro-plan-test-"))
  const substitutedPath = join(directory, "substitution-ran")
  const redirectedPath = join(directory, "redirect-ran")

  try {
    validatePlanCommands(
      planWith(`printf '%s\\n' "$(touch ${substitutedPath})" > ${redirectedPath}`),
    )
    await assert.rejects(access(substitutedPath), /ENOENT/)
    await assert.rejects(access(redirectedPath), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects obviously dangerous generated commands", () => {
  const dangerousCommands = [
    "sudo python -m pytest",
    "shutdown -h now",
    "reboot",
    "mkfs.ext4 /tmp/disk.img",
    "dd if=/dev/zero of=/dev/sda",
    "cat payload > /dev/sda",
  ]

  for (const command of dangerousCommands) {
    assert.throws(() => validatePlanCommands(planWith(command)), /blocked operation/)
  }
})
