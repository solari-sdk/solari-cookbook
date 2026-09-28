// SPDX-License-Identifier: AGPL-3.0-only
// Which catalog agents wsp can open a thread on. The runtime's adapter
// registry is typed by this list, so an id here without a factory there does
// not build and a factory there without an id here does not either; the list
// lives with the catalog rows because the wizard, the recipe verbs and the verb
// table behind both the command line and the MCP tools read it, and none of
// them may pull the runtime in.

export const THREAD_AGENTS = ["claude", "codex"] as const;
export type ThreadAgent = (typeof THREAD_AGENTS)[number];

/** Whether wsp can open a thread on this agent; the others it installs and manages only. */
export const runsThreads = (id: string): boolean => (THREAD_AGENTS as readonly string[]).includes(id);
