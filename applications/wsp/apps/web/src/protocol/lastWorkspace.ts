// SPDX-License-Identifier: AGPL-3.0-only
// The workspace the person had open last, kept in local storage under the
// state file the host serves, so the app opens where they left it and two
// state files served from one origin each keep their own.
import { bootPayload } from "../boot.js";

export const LAST_WORKSPACE_KEY = "wsp:last-workspace:v1";

/** The state file this page's host serves; a page with no host (tests, dev) shares one unnamed slot. */
const stateFile = (): string => bootPayload()?.statePath ?? "";

function readAll(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(LAST_WORKSPACE_KEY) ?? "{}");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

export function lastWorkspaceId(): string | undefined {
  return readAll()[stateFile()];
}

/** A storage that throws leaves the page opening on the first row next time. */
export function rememberWorkspace(id: string): void {
  try {
    const all = readAll();
    if (all[stateFile()] === id) return;
    window.localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify({ ...all, [stateFile()]: id }));
  } catch {
    return;
  }
}
