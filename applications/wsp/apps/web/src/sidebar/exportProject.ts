// SPDX-License-Identifier: AGPL-3.0-only
// What the export dialog computes from the wire and the store: which events
// are its own, the agent rows the workspace's threads give it and the request
// their ticks become, where a picked parent folder lands the project, and the
// landed line. The progress line the events fold into is the protocol's. No
// React here.
import type { ProjectExportEvent, ProjectExportResult, SessionView } from "@wsp/protocol";
import { folderName } from "./projectTrip.js";

export { exportProgress } from "@wsp/protocol";

/** Whether an event is this export's: the runtime echoes the destination as sent. */
export function isExportOf(e: ProjectExportEvent, workspaceId: string, dest: string): boolean {
  return e.workspaceId === workspaceId && e.dest === dest;
}

/** One row per agent that ran a thread on the workspace, by harness id, in first-seen order. */
export function agentRows(sessions: readonly SessionView[] | undefined): string[] {
  return [...new Set((sessions ?? []).map(s => s.harness))];
}

/** The request the ticks become: nothing while every row is ticked, so every agent with sessions comes home; else the ticked ids. */
export function agentsRequest(rows: readonly string[], ticked: ReadonlySet<string>): string[] | undefined {
  return rows.every(r => ticked.has(r)) ? undefined : rows.filter(r => ticked.has(r));
}

/** A folder picker can only name a folder that exists, so the project lands inside it under its own name. */
export function pickedDest(picked: string, source: string): string {
  return `${picked.replace(/\/+$/, "")}/${folderName(source)}`;
}

/** Where the folder landed on this Mac; the caches and each agent's outcome are in their rows, so only the fact no row
 * can carry, that the workspace had no sessions for it, joins the line. */
export function exportLandedLine(result: ProjectExportResult, source: string): string {
  const sessions = result.agents.length === 0 ? "; no agent sessions for it on the task" : "";
  return `${folderName(source)} is at ${result.dest} on this Mac${sessions}.`;
}
