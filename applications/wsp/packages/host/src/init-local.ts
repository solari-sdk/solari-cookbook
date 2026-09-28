// SPDX-License-Identifier: AGPL-3.0-only
// wsp init on a computer with no machine provider key. There is no machine to
// build on, so nothing is read off this computer, nothing is installed and
// nothing is sealed: this computer becomes the workspace instead, the app
// starts on it, and the run says what a key would add later. It is the whole
// of init for a person who wants no cloud, and the first half of it for one
// who adds a key afterwards; a second wsp init with a key takes the golden
// road and leaves this workspace where it is.
import { isCancel, log, outro } from "@clack/prompts";
import { NO_PROVIDER_LINE, THIS_COMPUTER, isLocalWorkspace, type AppPorts, type PortsAsked, type WorkspaceView } from "@wsp/protocol";
import type { Runtime } from "@wsp/runtime";
import { appUrl, askAlsoLocal, runLocal } from "./init-first.js";
import { hostRunDir } from "./host-lock.js";
import { openApp, pickPorts } from "./init-serve.js";
import type { PortProbes } from "./ports.js";
import type { HostHandle, WorkspaceRoads } from "./server.js";
import { KEY_LAYER_WORDS } from "./env-keys.js";
import type { InitIO, InitResult } from "./init.js";

/** What this run does and does not do, said before it does any of it: no key, so no image and no machine, and the
 * one command that adds the cloud later. */
export function noKeyLines(upCommand: string): string[] {
  return [
    NO_PROVIDER_LINE,
    `So this run seals nothing and boots nothing. It makes your first workspace a copy of a folder on ${THIS_COMPUTER}: threads run in it, under your own sign-ins, with the agents already on your PATH.`,
    `Put a Solari API key in ${KEY_LAYER_WORDS} and run wsp init again for the cloud half: an image of this computer, and machines forked from it. This workspace stays as it is.`,
    `${upCommand} starts the app again after this terminal is closed.`,
  ];
}

export interface LocalInitOptions {
  /** Take the default and ask nothing, as the golden road reads the same flag. */
  yes: boolean;
  /** Ask nothing here and serve nothing: an agent is driving. */
  nonInteractive?: boolean;
  statePath: string;
  ports: PortsAsked & PortProbes;
  /** The address the host this run serves binds; this computer alone when absent. */
  address?: string;
  /** The command that starts the app again, with the flags this run was given. */
  upCommand: string;
  /** A folder on this computer to record as a project and copy for the first workspace, which is what a workspace
   * here is; absent, this run makes none. */
  importFolder?: string;
  /** The runtime over this state file, its provider module the one that holds no machine. */
  runtime(): Runtime;
  /** The workspace roads for a run that serves nothing. */
  roads(rt: Runtime): WorkspaceRoads;
  /** Starts the app over the runtime, on a run at a terminal without --non-interactive. */
  host(rt: Runtime, ports: AppPorts): Promise<HostHandle>;
}

/** The local road end to end: the card, the ports, this computer as a workspace, the app on it. */
export async function runLocalInit(opts: LocalInitOptions, io: InitIO): Promise<InitResult> {
  const out = { output: io.output };
  const interactive = io.isTTY && !opts.yes && opts.nonInteractive !== true;
  const serves = io.isTTY && opts.nonInteractive !== true;
  log.info(noKeyLines(opts.upCommand).join("\n"), out);
  let ports: AppPorts = { port: opts.ports.port, wsPort: opts.ports.wsPort };
  if (serves) {
    const chosen = await pickPorts({ ports: opts.ports, statePath: opts.statePath, output: io.output });
    if (chosen === undefined) return { code: 1 };
    ports = chosen;
  }
  const rt = opts.runtime();
  const closeRuntime = (): Promise<void> => rt.close().catch((e: unknown) => log.warn(`the runtime did not close cleanly: ${e instanceof Error ? e.message : String(e)}`, out));
  // The one this host already holds, if any: a second wsp init on the local road opens the app on it rather than
  // asking the runtime for a workspace it would refuse. A state holding machines this host has no key for refuses
  // here, with the provider's own sentence, rather than after the tick.
  let workspace: WorkspaceView | undefined;
  try {
    workspace = (await rt.workspaces.list()).find(isLocalWorkspace);
  } catch (e) {
    await closeRuntime();
    throw e;
  }
  let handle: HostHandle | undefined;
  if (serves) {
    try {
      handle = await opts.host(rt, ports);
    } catch (e) {
      log.error(e instanceof Error ? e.message : String(e), out);
      outro(`The app did not start; fix that and run ${opts.upCommand}, with --port when a port is taken.`, out);
      await closeRuntime();
      return { code: 1 };
    }
  }
  const roads: WorkspaceRoads = handle ?? opts.roads(rt);
  if (workspace === undefined) {
    // The workspace step the golden road ends with, less the fork this road has no image for: the tick alone, on by
    // default, and nobody at a terminal takes the default since this computer costs nothing.
    const tick = interactive ? await askAlsoLocal({ input: io.input, output: io.output }) : true;
    if (isCancel(tick)) {
      await closeRuntime();
      return { code: 1 };
    }
    if (tick) workspace = await runLocal(roads, io.output, opts.importFolder);
  } else {
    log.step(`${workspace.name} (${workspace.id}) is already the workspace here; this run opens the app on it.`, out);
  }
  if (handle === undefined) {
    io.json?.({ event: "done", nextCommand: opts.upCommand, ...(workspace !== undefined ? { workspace: { id: workspace.id, name: workspace.name } } : {}) });
    outro(`Done. ${workspace === undefined ? `Nothing was made; wsp add <folder> records a project here and wsp new "<what you are working on>" makes its workspace.` : `${opts.upCommand} starts the app on ${workspace.name}.`}`, out);
    await closeRuntime();
    return { code: 0 };
  }
  const at = { port: handle.port, address: opts.address };
  await openApp(appUrl(at, workspace?.id, await handle.hereCode()), at, io, interactive, { runDir: hostRunDir(opts.statePath) });
  outro("wsp keeps serving the app from this terminal; Ctrl-C stops it.", out);
  return { code: 0, handle };
}
