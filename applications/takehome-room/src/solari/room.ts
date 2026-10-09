// The Room: one Solari desktop per Interview. Everything that touches the desktop
// is here. Facts below were measured on the `code` template, 2026-10-08 and -09.
import { createWriteStream } from "node:fs"
import { dirname } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { Desktop } from "@solarisdk/desktop"
import type { Task } from "../tasks.ts"
import type { OpenedRoom, Collected, RoomState } from "../flow.ts"
import { desktops, sandboxes } from "./client.ts"

// exec() runs as root with no HOME, but the GUI session (and so VS Code) runs as
// `desktop`. Files root writes must be handed to `desktop`, or VS Code cannot save them.
const USER = "desktop"
const HOME = `/home/${USER}`
const TASK_DIR = `${HOME}/task`

// Handles for Rooms this process opened, so collect() reuses the open control channel.
const open = new Map<string, Desktop>()

/**
 * A live handle to the Room, resuming it first if it paused. A pause drops the
 * control channel, so a cached handle is only trusted while the Room is "ready".
 */
async function handle(roomId: string): Promise<Desktop> {
  const known = open.get(roomId)
  const { status } = await desktops().get(roomId)
  if (status === "gone") throw new Error("The Room no longer exists")
  // Status alone is not enough: for up to a minute after a pause, it still says
  // "ready" while the control channel is already dead. Ask the handle itself.
  if (known && status === "ready" && (await known.health().then(Boolean, () => false))) return known
  known?.close()
  open.delete(roomId)
  // connect(id) resumes a paused desktop. While a pause settles (up to about a
  // minute) and while a resume restores (about 10 s), connections are refused,
  // so retry for a little over a minute.
  for (let attempt = 1; ; attempt++) {
    try {
      const d = await desktops().connect(roomId)
      await d.connect()
      await waitReady(d)
      open.set(roomId, d)
      return d
    } catch (e) {
      if (attempt >= 14) throw e
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}

/**
 * Resumes the Room if it paused while the Candidate was away, and reports a Room
 * that no longer exists. Opening the stream alone does not reliably wake it
 * (autoResume woke it in one test, not the next).
 * "unknown" means Solari could not be asked, which is not proof of anything.
 */
export async function wakeRoom(roomId: string): Promise<RoomState> {
  let status: string
  try {
    status = (await desktops().get(roomId)).status
  } catch {
    return "unknown"
  }
  if (status === "gone") return "gone"
  if (status === "paused") await handle(roomId)
  return "alive"
}

/** Commands are not shell-interpreted, so shell syntax goes through `sh -c`. */
async function sh(d: Desktop, script: string): Promise<string> {
  const r = await d.exec("sh", { args: ["-c", script], timeoutMs: 120_000 })
  if (r.exitCode !== 0) throw new Error(`Room command failed (${r.exitCode}): ${script}\n${r.stderr || r.stdout}`)
  return r.stdout
}

const asUser = (script: string) => `runuser -l ${USER} -c ${JSON.stringify(script)}`

async function waitReady(d: Desktop) {
  for (let i = 0; i < 30; i++) {
    const h = await d.health().catch(() => undefined)
    if (h?.ready) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error("The Room did not become ready within 30 s")
}

const EDITOR_SETTINGS = `${HOME}/.config/Code/User/settings.json`

/**
 * collect() can only take what is on disk. In a demo on 2026-10-09 the Candidate
 * never saved, and the hidden tests ran on the untouched starter. So VS Code saves
 * by itself a second after each edit. Workspace trust is off, or the task folder
 * opens in Restricted Mode with a banner across the top.
 */
async function configureEditor(d: Desktop) {
  // As the Candidate, so the new folders belong to them and VS Code can write there.
  await sh(d, asUser(`mkdir -p ${dirname(EDITOR_SETTINGS)}`))
  let settings: Record<string, unknown> = {}
  const raw = await d.fs.read(EDITOR_SETTINGS).then((b) => new TextDecoder().decode(b), () => undefined)
  if (raw !== undefined) {
    try {
      settings = JSON.parse(raw)
    } catch {
      // Comments or trailing commas: keep the template's file next to ours.
      await d.fs.write(`${EDITOR_SETTINGS}.bak`, new TextEncoder().encode(raw))
    }
  }
  settings = {
    ...settings,
    "files.autoSave": "afterDelay",
    "files.autoSaveDelay": 1000,
    "security.workspace.trust.enabled": false,
  }
  await d.fs.write(EDITOR_SETTINGS, new TextEncoder().encode(JSON.stringify(settings, null, 2)))
  await sh(d, `chown ${USER}:${USER} ${EDITOR_SETTINGS}*`)
}

export async function openRoom(task: Task, interviewId: string): Promise<OpenedRoom> {
  const d = await desktops().create({
    template: "code", // VS Code, Git and Python 3.10. No Node, Cursor or Claude Code.
    resolution: "1600x900",
    cpu: 2,
    memMb: 4096,
    record: true,
    // Lets list() find every Room this app made, for example leftovers.
    metadata: { ...TAG, interview: interviewId },
    // A rolling idle window, not a deadline. If the Candidate's laptop sleeps or
    // their network drops for this long, the Room pauses: its disk, memory and open
    // apps are saved, and wakeRoom() brings it back. "kill" would lose their work.
    // The server still kills the Room when the Interview clock ends.
    idleTimeoutMs: 20 * 60_000,
    lifecycle: { onTimeout: "pause", autoResume: true },
  })
  try {
    await d.connect()
    await waitReady(d)

    const dirs = new Set(task.starter.map((f) => dirname(`${TASK_DIR}/${f.path}`)))
    await sh(d, `mkdir -p ${[...dirs].map((p) => JSON.stringify(p)).join(" ")}`)
    for (const f of task.starter) await d.fs.write(`${TASK_DIR}/${f.path}`, new Uint8Array(f.content))
    await sh(d, `chown -R ${USER}:${USER} ${TASK_DIR}`)
    // A starting commit, so the Report shows only the Candidate's own commits on top.
    // The Candidate can change this identity. It only stops Git refusing to commit.
    await sh(
      d,
      asUser(
        "git config --global user.name Candidate && git config --global user.email candidate@takehome.invalid && " +
          "cd ~/task && git init -q -b main && git add -A && git commit -qm 'Starting point'",
      ),
    )

    await configureEditor(d)
    await d.record.start({ fps: 10 })
    await d.open("code", [TASK_DIR])
    open.set(d.id, d)
    return { roomId: d.id, streamUrl: d.streamUrl, recordingUrl: d.recordingUrl }
  } catch (e) {
    await killRoom(d.id)
    throw e
  }
}

/** Stops the Recording, takes the Final state out, and kills the Room. */
export async function collectRoom(roomId: string): Promise<Collected> {
  const d = await handle(roomId)
  try {
    // A failed stop must not lose the Candidate's work, so carry on regardless.
    await d.record.stop().catch((e) => console.error(`record.stop failed for ${roomId}:`, e))
    const gitLog = await sh(
      d,
      `git -c safe.directory='*' -C ${TASK_DIR} log --format='%h %ad %s' --date=iso-strict 2>&1 || true`,
    )
    await sh(d, `tar czf /tmp/final.tgz -C ${HOME} task`)
    const finalState = await d.fs.read("/tmp/final.tgz")
    return { gitLog, finalState }
  } finally {
    await killRoom(roomId)
  }
}

const TAG = { app: "takehome-room" }

/** Is this Room alive by either view Solari offers? They disagree for a while after a kill. */
async function stillAlive(roomId: string): Promise<boolean> {
  const status = await desktops()
    .get(roomId)
    .then((g) => g.status, () => "gone")
  if (status !== "gone") return true
  const { sandboxes: rows } = await sandboxes()
    .list({ metadata: TAG })
    .catch(() => ({ sandboxes: [] }))
  return rows.some((r) => r.sandboxId === roomId && r.state !== "gone")
}

/**
 * kill(), not close(): close() only drops the control channel and the desktop keeps
 * billing. Then make sure it stays dead. In testing, a desktop that had been paused
 * came back after a kill that returned "ok", and the account list showed it in some
 * checks and not others. So kill, watch both views for 30 s, and kill again if it
 * reappears.
 */
export async function killRoom(roomId: string): Promise<void> {
  const d = open.get(roomId)
  open.delete(roomId)
  d?.close()
  for (let attempt = 1; attempt <= 4; attempt++) {
    // The sandbox client's kill() works on desktops too.
    await sandboxes()
      .kill(roomId)
      .catch((e) => console.error(`kill attempt ${attempt} failed for ${roomId}:`, e))
    let clean = 0
    while (clean < 10) {
      await new Promise((r) => setTimeout(r, 3000))
      if (await stillAlive(roomId)) break
      clean++
    }
    if (clean >= 10) return
  }
  console.error(`Room ${roomId} is still alive after 4 kills. Kill it in the Solari console.`)
}

/**
 * The recording URL is a presigned storage link that works for 7 days and needs
 * no key. Copy the video to our own storage and never show the link itself.
 */
export async function saveRecording(url: string, path: string): Promise<boolean> {
  // The desktop uploads the mp4 after record.stop(), so poll briefly.
  for (let i = 0; i < 24; i++) {
    const res = await fetch(url)
    if (res.ok && res.body) {
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(path))
      return true
    }
    await res.body?.cancel()
    await new Promise((r) => setTimeout(r, 5000))
  }
  return false
}
