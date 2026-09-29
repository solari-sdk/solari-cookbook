import fs from "node:fs/promises"
import type { PortalStatus } from "./types.js"

export async function loadState(filePath: string): Promise<Record<string, PortalStatus>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch {
    return {}
  }
}

export async function saveState(filePath: string, state: Record<string, PortalStatus>): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(state, null, 2))
}
