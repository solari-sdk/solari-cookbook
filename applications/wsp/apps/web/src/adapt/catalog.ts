// SPDX-License-Identifier: AGPL-3.0-only
// The composer's slash-command catalog. t3code fills it from provider probes;
// wsp reads it off session.start's harness field (the CLI's own system/init)
// once a session has run, and the harness's registered seed fills the menu
// before that. The CLI's init lists its screen-only commands beside the ones
// a headless turn runs, so the runtime catalog's table of those is taken out
// of either list here. The model, effort and permission pickers read the
// runtime's harness catalog instead, since those must be right before any
// session ran.
import { screenCommandTyped, type ScreenCommand, type SessionHarness } from "@wsp/protocol";
import { harnessClient } from "./harnesses.js";
import type { HarnessCatalog, ProviderSlashCommand } from "./view-model.js";

/** The seed catalog of a harness with a registered module, else nothing. */
export function catalogFor(harness: string): HarnessCatalog | null {
  const client = harnessClient(harness);
  return client === undefined ? null : { harness, slashCommands: client.slashCommands };
}

/** The slash commands a session announced, else the harness's seed when the CLI said nothing about them, less the
 * ones its runtime catalog says work only in the CLI's own terminal. */
export function catalogFromHarness(input: { readonly id: string; readonly harness: SessionHarness | null; readonly screen?: ReadonlyArray<ScreenCommand> }): HarnessCatalog {
  const announced = harnessClient(input.id)?.announced;
  const offered: ReadonlyArray<ProviderSlashCommand> =
    input.harness?.slashCommands !== undefined && input.harness.slashCommands.length > 0
      ? input.harness.slashCommands.map(name => (announced === undefined ? { name } : announced(name)))
      : harnessClient(input.id)?.slashCommands ?? [];
  const screen = input.screen ?? [];
  const slashCommands = screen.length === 0 ? offered : offered.filter(c => !screen.some(s => s.name === c.name));
  return { harness: input.id, slashCommands };
}

const ASK = "Ask anything";

/** Whether the menu has a command to show. A menu opened on nothing answers a typed slash with its empty state, which
 * reads as a promise the app cannot keep, so the words below and the menu itself are decided here and nowhere else. */
export function offersSlashCommands(catalog: HarnessCatalog): boolean {
  return catalog.slashCommands.length > 0;
}

/** The composer's placeholder: it names the slash menu only where the menu has something to offer. */
export function composerPlaceholder(catalog: HarnessCatalog): string {
  return offersSlashCommands(catalog) ? `${ASK}, or / for commands` : ASK;
}

/** What the composer says when a draft that is a slash and nothing more is held. The first is true of every harness;
 * the second names the word that reached nothing. */
const LONE_SLASH = "a slash on its own is not a command";
const noCommandCalled = (name: string) => `no command here is called /${name}`;

/** Why a draft is held rather than sent, or null when its words are a message the agent can take. A slash opens a
 * command only where it opens the whole message and nothing else is in it, so this reads the draft whole: a lone
 * slash names nothing, and a lone name no announced command carries reaches the agent as a command it does not
 * have, which it answers with a question and bills for. Words after the name are words that may be meant and go as
 * they always did. A command that runs only in the CLI's own terminal is left to its own line, which names the wsp
 * control that serves it. */
export function slashHoldLine(input: { readonly prompt: string; readonly catalog: HarnessCatalog; readonly screen?: ReadonlyArray<ScreenCommand> }): string | null {
  const draft = input.prompt.trim();
  if (draft === "/") return LONE_SLASH;
  const name = /^\/(\S+)$/.exec(draft)?.[1];
  if (name === undefined || !offersSlashCommands(input.catalog)) return null;
  if (screenCommandTyped({ screenCommands: input.screen }, draft) !== null) return null;
  return input.catalog.slashCommands.some(command => command.name === name) ? null : noCommandCalled(name);
}
