// SPDX-License-Identifier: AGPL-3.0-only
// The last thing wsp init asks, once the golden is sealed: make the first
// workspace and put a project on it, and whether this computer becomes a
// workspace too. Yes forks from the golden just sealed, imports the folder
// under the consent the app's import dialog starts from, and answers with the
// address that opens the app on that workspace; No forks nothing. The tick
// beside it is on by default and costs nothing, so a person who answers No to
// the fork still ends in a workspace. The agent's road skips the questions and
// reads the same answers off --first-workspace, --import and --no-local.
import type { Readable, Writable } from "node:stream";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isCancel, log } from "@clack/prompts";
import type { Platform } from "@wsp/collect";
import { authority, canTravel, defaultAgents, defaultConsent, FIRST_WORKSPACE, fmtBytes, importRequest, openingHash, plural, THIS_COMPUTER, thisComputer, thisComputerLine, workspaceHash, type ProjectImportResult, type ProjectPlan, type WorkspaceView } from "@wsp/protocol";
import type { CreatedWorkspace } from "@wsp/runtime";
import { dialAddress } from "./host-lock.js";
import { confirmPrompt, textPrompt } from "./init-layout.js";
import type { HostHandle, WorkspaceRoads } from "./server.js";

/** The name the workspace step was answered with, or none. The step's answer is what decides the fork, not how many
 * workspaces the list already holds: a name forks whatever is there, and an empty field forks nothing. */
export function firstWorkspaceName(name: string | undefined): string | undefined {
  const text = name?.trim();
  return text === undefined || text === "" ? undefined : text;
}

export const FIRST_QUESTION = "Make your first workspace and import a project now?";
export const folderQuestion = (platform: Platform): string => `Which folder on ${thisComputer(platform)}?`;
/** The tick beside the fork: this computer as a workspace of its own. It boots nothing and bills nothing, so it is
 * on by default and a No to the fork above still leaves a workspace to open the app on. */
export const ALSO_LOCAL_QUESTION = `Also make ${THIS_COMPUTER} a workspace?`;
export const ALSO_LOCAL_HINT = "Threads run here, on your own machine, under your own sign-ins and the tools already on your PATH. Nothing is forked and nothing bills.";
/** What esc, or No to the fork with the tick off, leaves behind: the wizard's last line. */
export const DONE_LINE = "Done. wsp up starts the app; opening it now.";

/** What the last question settled: the workspace to fork and, when one was named, the folder whose project lands on it. */
export interface FirstWorkspace {
  name: string;
  folder?: string;
}

/** The whole workspace step: the fork the question asked for, when it asked for one, and whether this computer
 * becomes a workspace too. Both can be on, either can be off, and a step that leaves both off ends with none. */
export interface WorkspaceStep {
  fork?: FirstWorkspace;
  local: boolean;
}

export interface FirstAsk {
  /** Whether the person is at a terminal to answer; without one the flags and the defaults decide. */
  interactive: boolean;
  /** Nobody at a terminal (an agent driving, or no terminal): only a flag forks, since a workspace bills and the
   * caller did not ask for one. Off, a run that asks nothing still takes the question's default, a fork. This
   * computer is not a fork and bills nothing, so the tick stands whether anyone is here or not. */
  unattended: boolean;
  /** --first-workspace; naming one answers the question yes. */
  name?: string;
  /** --import; naming a folder answers the question yes and skips the folder prompt. */
  folder?: string;
  /** --no-local: the tick off, the one way to end an init with no local workspace. */
  noLocal?: boolean;
  /** The computer the folder is picked on, which is what the question calls it. */
  platform: Platform;
  input: Readable;
  output: Writable;
}

/** A folder as the wizard accepts it: a leading ~ is this computer's home, since the prompt reads the line and no
 * shell has expanded it; absolute as typed; anything else read against the working directory. Only ~ and ~/ expand:
 * ~alice is another user's home, which only a shell can find, so it goes through the working directory like any
 * other relative path and the import fails naming it. Empty is no folder, which forks the workspace on its own. */
export function folderOf(typed: string | undefined): string | undefined {
  const text = typed?.trim();
  if (text === undefined || text === "") return undefined;
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  return isAbsolute(text) ? text : resolve(text);
}

/** A folder named by --import, read before anything is collected or booted. The import itself runs minutes later,
 * once a golden is built and sealed, so a typo caught there costs the whole build and still exits 0; caught here it
 * costs nothing. Throws for the caller to report, as a recipe file that does not parse does. */
export function checkImportFolder(folder: string): void {
  let dir: boolean;
  try {
    dir = statSync(folder).isDirectory();
  } catch {
    throw new Error(`--import ${folder}: no folder there on this computer`);
  }
  if (!dir) throw new Error(`--import ${folder}: not a folder`);
}

/** The workspace step, or the flags in its place: the fork the question asks for and the tick beside it. The cancel
 * symbol is esc at the fork confirm, which ends the step with nothing made, the tick included. Esc at the tick or the
 * folder prompt is not a cancel: the answer above it stands, and the question it was pressed at reads as No. */
export async function askFirst(o: FirstAsk): Promise<WorkspaceStep | symbol> {
  const named = o.name !== undefined || o.folder !== undefined;
  const name = o.name ?? FIRST_WORKSPACE;
  const folder = folderOf(o.folder);
  const offered = o.noLocal !== true;
  const forked = { name, ...(folder !== undefined ? { folder } : {}) };
  // A flag is an answer already given; asking again would ask an agent's caller a question nobody is there to read.
  if (named) return { fork: forked, local: offered };
  if (o.unattended) return { local: offered };
  if (!o.interactive) return { fork: { name }, local: offered };
  const go = await confirmPrompt({
    message: FIRST_QUESTION,
    hint: `Enter forks a workspace from the image just sealed and imports a folder onto it. ${offered ? `No forks nothing; the next question offers ${THIS_COMPUTER} instead.` : "No leaves the app with none; you can make one there."}`,
    initialValue: true,
    input: o.input,
    output: o.output,
  });
  if (isCancel(go)) return go;
  const asked = offered ? await askAlsoLocal(o) : false;
  const local = asked === true;
  if (!go) return { local };
  const typed = await textPrompt({
    message: folderQuestion(o.platform),
    hint: "The folder lands on the machine at the path it has here; caches stay behind and secret-shaped files are cut. Enter with nothing imports no project.",
    input: o.input,
    output: o.output,
  });
  // Esc here leaves the folder, not the Yes just given: it forks the workspace with no project, as Enter on nothing does.
  const picked = isCancel(typed) ? undefined : folderOf(typed);
  return { fork: { name, ...(picked !== undefined ? { folder: picked } : {}) }, local };
}

/** The tick on its own, asked whether the fork above it was taken or not and asked alone on the road with no golden
 * to fork: a person who wants no cloud workspace is who the question is for. */
export async function askAlsoLocal(o: Pick<FirstAsk, "input" | "output">): Promise<boolean | symbol> {
  return confirmPrompt({ message: ALSO_LOCAL_QUESTION, hint: ALSO_LOCAL_HINT, initialValue: true, input: o.input, output: o.output });
}

/** What the run built: the workspace the address opens on, and what landed on it when a folder was named. */
export interface FirstResult {
  workspace: CreatedWorkspace;
  imported?: ProjectImportResult;
}

export interface FirstRun {
  first: FirstWorkspace;
  handle: Pick<HostHandle, "createWorkspace" | "planProject" | "importProject">;
  goldenVersion: number;
  output: Writable;
  /** Wraps a label while a promise runs; init's own spinner, already told whether to animate. */
  spin(label: string): { stop(): void };
  /** Under --json, one object per step of the fork and the import as it starts and as it ends. */
  json?(record: Record<string, unknown>): void;
}

/** What the plan says before anything is packed, in the wizard's one line. */
export function planLine(plan: ProjectPlan): string {
  const parts = [`${plural(plan.files, "file")}, ${fmtBytes(plan.bytes)}`];
  if (plan.repo) parts.push("the repository whole");
  const travelling = plan.agents.filter(canTravel);
  if (travelling.length > 0) parts.push(`${plural(travelling.reduce((n, a) => n + a.sessions, 0), "session")} from ${travelling.map(a => a.name).join(", ")}`);
  if (plan.secrets.length > 0) parts.push(`${plural(plan.secrets.length, "secret-shaped file")} read for what may travel`);
  return `${parts.join("; ")}.`;
}

/** Where the folder landed and what was left out of it. */
export function importedLine(result: ProjectImportResult, workspaceName: string): string {
  const cut = result.cut.length > 0 ? `; ${plural(result.cut.length, "secret-shaped file")} cut` : "";
  const rewritten = result.rewritten.length > 0 ? `; ${plural(result.rewritten.length, "file")} rewritten without their credentials` : "";
  return `${result.dest} on ${workspaceName}: ${plural(result.files, "file")}, ${fmtBytes(result.bytes)}${rewritten}${cut}.`;
}

/** Forks the workspace and, when a folder was named, lands its project on it under the app's own consent defaults.
 * A failed import keeps the workspace: the machine is there and the folder can be imported from the app. */
export async function runFirst(o: FirstRun): Promise<FirstResult | undefined> {
  const out = { output: o.output };
  const forking = o.spin(`Forking your first workspace, ${o.first.name}`);
  o.json?.({ event: "first-workspace", name: o.first.name, state: "forking" });
  let workspace: CreatedWorkspace;
  try {
    workspace = await o.handle.createWorkspace(o.first.name);
    forking.stop();
  } catch (e) {
    forking.stop();
    o.json?.({ event: "first-workspace", name: o.first.name, state: "failed", error: errorText(e) });
    log.warn(`The first workspace could not be forked: ${errorText(e)}. Create one from the app.`, out);
    return undefined;
  }
  o.json?.({ event: "first-workspace", name: o.first.name, state: "forked", workspace: { id: workspace.id, name: workspace.name } });
  log.step(`Workspace ${workspace.name} (${workspace.id}) forked from image v${o.goldenVersion}.${workspace.notice !== undefined ? ` ${workspace.notice}` : ""}`, out);
  if (o.first.folder === undefined) return { workspace };
  // Each line lands with the spinner stopped: a spinner redraws its own row from the first cell and would eat one printed under it.
  let spinner = o.spin(`Reading ${o.first.folder}`);
  o.json?.({ event: "import", folder: o.first.folder, state: "importing" });
  try {
    const plan = await o.handle.planProject(o.first.folder);
    spinner.stop();
    log.step(planLine(plan), out);
    spinner = o.spin(`Importing ${o.first.folder}`);
    // The app's dialog seeds its ticks from these two and sends this request; nothing is changed on the way here.
    const imported = await o.handle.importProject({ workspaceId: workspace.id, ...importRequest(plan, o.first.folder, defaultConsent(plan.secrets), defaultAgents(plan.agents)) });
    spinner.stop();
    o.json?.({ event: "import", folder: o.first.folder, state: "imported", dest: imported.dest, files: imported.files, bytes: imported.bytes });
    log.step(importedLine(imported, workspace.name), out);
    return { workspace, imported };
  } catch (e) {
    spinner.stop();
    o.json?.({ event: "import", folder: o.first.folder, state: "failed", error: errorText(e) });
    log.warn(`${o.first.folder} was not imported: ${errorText(e)}. The workspace is up; import it from the app.`, out);
    return { workspace };
  }
}

/** The tick taken: a folder of the person's own on this computer, recorded as a project, and a copy of it as the
 * first workspace, named as the golden road names its first, since it is the first piece of work and not this
 * computer. A run that named no folder makes none and says the road; a host that refuses it (a folder that is no
 * repo, a name taken) is one line and never unwinds the run, so the fork above it still stands and the address
 * still opens. */
export async function runLocal(roads: Pick<WorkspaceRoads, "addProject" | "createWorkspace">, output: Writable, folder?: string, name: string = FIRST_WORKSPACE): Promise<WorkspaceView | undefined> {
  if (folder === undefined) {
    log.warn(`${THIS_COMPUTER} was not made a workspace: a workspace is one project's, and this run named no folder here. wsp add <folder> records one and wsp new "<what you are working on>" makes its workspace.`, { output });
    return undefined;
  }
  try {
    const project = await roads.addProject(folder);
    const workspace = await roads.createWorkspace(name, undefined, project.id);
    log.step(thisComputerLine(workspace.name, workspace.id, folder), { output });
    return workspace;
  } catch (e) {
    log.warn(`${THIS_COMPUTER} was not made a workspace: ${errorText(e)}. wsp add <folder> records a project here and wsp new "<what you are working on>" makes its workspace.`, { output });
    return undefined;
  }
}

/** The app's address, on the workspace just forked when there is one, carrying the code that lets the browser it
 * opens in when the run minted one. Through the same rule every local client dials by, so an init told to bind one
 * address opens the browser there rather than at a loopback nothing answers. */
export const appUrl = (at: { port: number; address?: string }, workspaceId?: string, code?: string): string =>
  `http://${authority(dialAddress(at), at.port)}/${code !== undefined ? openingHash(code, workspaceId) : workspaceId === undefined ? "" : workspaceHash(workspaceId)}`;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
