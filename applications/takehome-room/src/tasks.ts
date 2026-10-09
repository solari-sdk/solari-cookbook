// A Task lives in tasks/<name>/: task.json, starter/ (copied into the Room) and
// hidden/ (the Hidden tests, which never enter the Room).
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

export interface Task {
  name: string
  title: string
  workMinutes: number
  setupMinutes: number
  /** The starter's README.md, shown on the Candidate's page as well as in the Room. */
  instructions: string
  starter: TaskFile[]
  hidden: TaskFile[]
}

export interface TaskFile {
  /** Path relative to the folder it came from, with forward slashes. */
  path: string
  content: Buffer
}

const TASKS_DIR = join(import.meta.dirname, "..", "tasks")

function walk(dir: string): TaskFile[] {
  const out: TaskFile[] = []
  const visit = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      if (statSync(full).isDirectory()) visit(full)
      else out.push({ path: relative(dir, full).split("\\").join("/"), content: readFileSync(full) })
    }
  }
  visit(dir)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export function listTasks(): string[] {
  return readdirSync(TASKS_DIR).filter((n) => statSync(join(TASKS_DIR, n)).isDirectory())
}

export function loadTask(name: string): Task {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Bad task name: ${name}`)
  const dir = join(TASKS_DIR, name)
  const meta = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"))
  const starter = walk(join(dir, "starter"))
  const hidden = walk(join(dir, "hidden"))
  if (hidden.length === 0) throw new Error(`Task ${name} has no hidden tests`)
  const readme = starter.find((f) => f.path === "README.md")
  return {
    name,
    title: meta.title,
    workMinutes: meta.workMinutes,
    setupMinutes: meta.setupMinutes,
    instructions: readme ? readme.content.toString("utf8") : "",
    starter,
    hidden,
  }
}
