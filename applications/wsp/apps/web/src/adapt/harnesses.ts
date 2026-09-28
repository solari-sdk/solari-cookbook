// SPDX-License-Identifier: AGPL-3.0-only
// The client's own facts per harness: the slash commands its menu is seeded
// with before a session has announced any. One module per harness; a harness
// without one gets an empty seed. No seed names a command the CLI runs only in
// its own terminal; those are the runtime catalog's table, read by the menu.
// The runtime's catalog answers everything else, the agent's mark included.
import type { ProviderSlashCommand } from "./view-model.js";

export interface HarnessClient {
  readonly harness: string;
  readonly slashCommands: ReadonlyArray<ProviderSlashCommand>;
  /** One announced name as this CLI spells it. Only a harness's own module knows whether its names carry where a
   * command came from, so the reading lives here and the catalog asks for it by harness; a harness without one
   * announces bare names and its menu is one list. */
  readonly announced?: (name: string) => ProviderSlashCommand;
}

const NO_SLASH_SEED: ReadonlyArray<ProviderSlashCommand> = [];

/** This CLI names a plugin's or a scoped skill's command `<source>:<command>` and announces everything else as a
 * bare name, with nothing in it that tells one of its own commands from a skill. So the prefix is the only source
 * it names, and a menu that grouped on anything more would be grouping on a guess. */
const CLAUDE_SOURCED = /^([^:\s]+):[^:\s]+$/;

function claudeAnnounced(name: string): ProviderSlashCommand {
  const source = CLAUDE_SOURCED.exec(name)?.[1];
  return source === undefined ? { name } : { name, source };
}

export const CLAUDE_CLIENT: HarnessClient = { harness: "claude", slashCommands: NO_SLASH_SEED, announced: claudeAnnounced };

export const CODEX_CLIENT: HarnessClient = { harness: "codex", slashCommands: NO_SLASH_SEED };

export const GEMINI_CLIENT: HarnessClient = { harness: "gemini", slashCommands: NO_SLASH_SEED };

export const OPENCODE_CLIENT: HarnessClient = { harness: "opencode", slashCommands: NO_SLASH_SEED };

export const PI_CLIENT: HarnessClient = { harness: "pi", slashCommands: NO_SLASH_SEED };

export const HARNESS_CLIENTS: ReadonlyArray<HarnessClient> = [CLAUDE_CLIENT, CODEX_CLIENT, GEMINI_CLIENT, OPENCODE_CLIENT, PI_CLIENT];

export function harnessClient(harness: string): HarnessClient | undefined {
  return HARNESS_CLIENTS.find(c => c.harness === harness);
}
