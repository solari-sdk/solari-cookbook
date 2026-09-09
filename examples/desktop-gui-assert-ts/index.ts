/**
 * Prove a GUI action actually did something.
 *
 * The hard part of desktop automation is not clicking. It is knowing whether
 * the click worked. A screenshot shows you a dialog closing; it cannot tell you
 * the file was written, and "it looked right" is how a green run hides a broken
 * save. Computer-use agents that only ever look at pixels inherit that problem.
 *
 * So this drives a real GUI app and then checks two independent things:
 *
 *   1. What the app CLAIMS. Mousepad puts a `*` in its window title while
 *      there are unsaved changes, so the title is the app's own answer.
 *   2. What is actually TRUE. The bytes on disk, read back over the sandbox
 *      filesystem API.
 *
 * Both have to agree. The screenshot is filed as evidence afterwards, not used
 * as the verdict.
 *
 * Mousepad is the subject on purpose: it has no headless mode, so this is work
 * a screen is genuinely required for rather than decoration.
 */
import { writeFileSync } from "node:fs"
import { SolariClient } from "@solarisdk/sdk"

const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
const FILE = "/root/note.txt"
const TEXT = "typed into a real GUI, verified on disk"

const desktop = await pt.sandboxes.createDesktop({ resolution: "1280x720", timeoutMs: 5 * 60_000 })

try {
  await desktop.connect()
  // Every X client needs DISPLAY; the desktop runs one Xvfb on :0.
  const sh = async (script: string) => {
    const r = await desktop.commands.run("sh", { args: ["-c", `DISPLAY=:0 ${script}`] })
    return (r.stdout ?? "").trim()
  }

  await sh(`rm -f ${FILE}; nohup mousepad ${FILE} >/tmp/mousepad.log 2>&1 & echo started`)
  // --sync waits for the window to exist instead of racing the app's startup.
  const win = await sh(`xdotool search --sync --onlyvisible --name 'note.txt' | head -1`)
  if (!win) throw new Error("mousepad never opened a window")

  const before = await sh(`xdotool getwindowname ${win}`)
  console.log(`window ${win}: ${before}`)

  await sh(`xdotool windowactivate --sync ${win} && xdotool type --delay 30 '${TEXT}'`)
  const dirty = await sh(`xdotool getwindowname ${win}`)
  // The leading `*` is Mousepad saying it has unsaved changes. If typing had
  // gone to the wrong window this would still read clean, which is the point.
  if (!dirty.startsWith("*")) throw new Error(`expected unsaved marker after typing, got: ${dirty}`)
  console.log(`after typing:  ${dirty}   (the * means unsaved)`)

  await sh(`xdotool key --clearmodifiers ctrl+s`)
  await new Promise((r) => setTimeout(r, 2000))

  const saved = await sh(`xdotool getwindowname ${win}`)
  console.log(`after ctrl+s:  ${saved}`)

  // 1. What the app claims.
  const appSaysSaved = !saved.startsWith("*")
  // 2. What is true. This is the one that counts.
  const onDisk = await desktop.files.readText(FILE)
  const diskAgrees = onDisk === TEXT

  console.log(`\napp claims saved: ${appSaysSaved}`)
  console.log(`disk agrees:      ${diskAgrees} (${onDisk.length} bytes)`)

  const shot = await desktop.screenshot()
  writeFileSync(new URL("./evidence.png", import.meta.url), shot)
  console.log(`evidence.png:     ${shot.length} bytes`)

  if (!appSaysSaved || !diskAgrees) {
    throw new Error(`GUI action did not take effect. on disk: ${JSON.stringify(onDisk)}`)
  }
  console.log(`\nBoth agree, so the save really happened. A screenshot alone could not`)
  console.log(`have told you that -- the window looks identical either way.`)
} finally {
  await desktop.kill()
}
