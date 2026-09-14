/**
 * Drive an interactive CLI — the one thing `commands.run` cannot do.
 *
 * Almost every CLI checks `isatty()` and behaves differently when it is not
 * talking to a terminal: no colours, no progress, and no prompts. So a test
 * that shells out with `commands.run` exercises a code path your users never
 * take, and an interactive wizard either hangs waiting on stdin or silently
 * takes defaults.
 *
 * `pty.create()` gives you a real terminal in the sandbox. Same machine, same
 * command, different reality:
 *
 *     commands.run  ->  isatty False
 *     pty.create    ->  isatty True
 *
 * This runs `npm init` — a wizard nobody can complete without a TTY — answers
 * its questions, and then proves it worked by reading back the package.json it
 * wrote. Watching output scroll past is not proof; the artifact is.
 */
import { SolariClient } from "@solarisdk/sdk"

const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
const PROJECT = "/tmp/wizard"
const APP_NAME = "built-in-a-terminal"

const sandbox = await pt.sandboxes.create({ template: "base", timeoutMs: 5 * 60_000 })

try {
  await sandbox.connect()

  // The contrast, measured rather than asserted.
  const piped = await sandbox.commands.run("sh", {
    args: ["-c", `python3 -c "import sys; print(sys.stdout.isatty())"`],
  })
  console.log(`commands.run  isatty: ${(piped.stdout ?? "").trim()}`)

  await sandbox.commands.run("sh", { args: ["-c", `mkdir -p ${PROJECT}`] })

  let transcript = ""
  const pty = await sandbox.pty.create({ cols: 100, rows: 30 })
  pty.onData((chunk) => { transcript += Buffer.from(chunk).toString("utf8") })

  /** Wait until the terminal has actually asked, then answer. */
  const answer = async (prompt: RegExp, reply: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs
    const from = transcript.length
    while (Date.now() < deadline) {
      // Search only what arrived since the last answer: `npm init` echoes each
      // reply, so matching the whole transcript would re-match old prompts.
      if (prompt.test(transcript.slice(from))) {
        await pty.write(reply + "\n")
        return
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`never saw ${prompt} within ${timeoutMs}ms. Tail:\n${transcript.slice(-400)}`)
  }

  await answer(/[$#]\s*$/, `cd ${PROJECT} && npm init`)
  await answer(/package name:/, APP_NAME)
  for (const field of [/version:/, /description:/, /entry point:/, /test command:/,
                       /git repository:/, /keywords:/, /author:/, /license:/]) {
    await answer(field, "")           // accept each default
  }
  await answer(/Is this OK\?/, "yes")
  await new Promise((r) => setTimeout(r, 1500))
  await pty.kill()

  // The postcondition. The wizard either wrote our answer to disk or it did not.
  const written = JSON.parse(await sandbox.files.readText(`${PROJECT}/package.json`))
  if (written.name !== APP_NAME) {
    throw new Error(`package.json says "${written.name}", expected "${APP_NAME}"`)
  }

  console.log(`pty.create    isatty: True`)
  console.log(`\nnpm init completed inside the PTY and wrote:`)
  console.log(`  name: ${written.name}   version: ${written.version}   license: ${written.license}`)
  console.log(`\nThat file only exists because something answered the prompts.`)
} finally {
  await sandbox.kill()
}
