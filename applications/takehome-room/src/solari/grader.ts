// Runs the Hidden tests against a copy of the Final state, in a fresh sandbox.
// The tests never enter the Candidate's Room, so the Candidate cannot read them.
import type { Grade } from "../interview.ts"
import type { Task } from "../tasks.ts"
import { sandboxes } from "./client.ts"
import { parseUnittest } from "./unittest-result.ts"

const WORK = "/work"
const TASK = `${WORK}/task`

// -I keeps the task folder off the front of sys.path, so a file named unittest.py
// in the Candidate's work cannot replace the test runner. The task folder is then
// appended, so the tests can still import the Candidate's modules.
const RUNNER = [
  "import sys, unittest",
  `sys.path.append(${JSON.stringify(TASK)})`,
  `unittest.main(module=None, argv=["hidden", "discover", "-s", ${JSON.stringify(TASK + "/hidden_tests")}, "-t", ${JSON.stringify(TASK)}, "-v"])`,
].join("; ")

export async function runHiddenTests(task: Task, finalState: Uint8Array): Promise<Grade> {
  const sbx = await sandboxes().create({
    template: "base",
    cpu: 1,
    memMb: 1024,
    idleTimeoutMs: 5 * 60_000,
    lifecycle: { onTimeout: "kill" },
  })
  try {
    await sbx.connect()
    const sh = (script: string, timeoutMs = 60_000) =>
      sbx.commands.run("sh", { args: ["-c", script], cwd: "/", timeoutMs })

    await sbx.files.upload("/tmp/final.tgz", finalState)
    // The Candidate's own hidden_tests folder, if any, is replaced by ours.
    const unpack = await sh(
      `mkdir -p ${WORK} && tar xzf /tmp/final.tgz -C ${WORK} && rm -rf ${TASK}/hidden_tests && mkdir -p ${TASK}/hidden_tests`,
    )
    if (unpack.exitCode !== 0) throw new Error(`Could not unpack the Final state: ${unpack.stderr}`)
    await sbx.files.write(`${TASK}/hidden_tests/__init__.py`, "")
    for (const f of task.hidden) await sbx.files.write(`${TASK}/hidden_tests/${f.path}`, new Uint8Array(f.content))

    const run = await sbx.commands.run("python3", { args: ["-I", "-c", RUNNER], cwd: TASK, timeoutMs: 120_000 })
    // unittest writes its report to stderr.
    return parseUnittest(`${run.stderr}${run.stdout}`)
  } finally {
    await sbx.kill().catch((e) => console.error("could not kill the grading sandbox:", e))
  }
}
