// SPDX-License-Identifier: AGPL-3.0-only
// What every client computes from a project plan before an import: which
// secret-shaped rows start ticked, which agents' sessions start ticked, when
// a person's answers count as consent, the one request those ticks become,
// and the words for a row's tick. The app's dialog, the command line and the
// MCP server read one plan the same way and send the same request.
import type { ProjectAgent, ProjectPlan, ProjectSecret } from "./index.js";

/** A rewrite removes the credentials, so it starts ticked; a file that would travel as it is never does. */
export function defaultConsent(secrets: readonly ProjectSecret[]): ReadonlySet<string> {
  return new Set(secrets.filter(s => s.rewrite !== undefined).map(s => s.path));
}

/** The request the ticks become: offered files rewrite, the rest carry; everything unticked is cut and named by the runtime. */
export function consentRequest(secrets: readonly ProjectSecret[], ticked: ReadonlySet<string>): { carry: string[]; rewrite: string[] } {
  const chosen = secrets.filter(s => ticked.has(s.path));
  return {
    carry: chosen.filter(s => s.rewrite === undefined).map(s => s.path),
    rewrite: chosen.filter(s => s.rewrite !== undefined).map(s => s.path),
  };
}

/** Only an agent with sessions the plan could read has anything to send; the runtime never reads one it cannot. */
export const canTravel = (a: ProjectAgent): boolean => a.error === undefined && a.sessions > 0;

/** An agent whose sessions can travel starts ticked; one with none, or whose store could not be read, does not. */
export function defaultAgents(agents: readonly ProjectAgent[]): ReadonlySet<string> {
  return new Set(agents.filter(canTravel).map(a => a.agent));
}

/** The request the agent ticks become, in the plan's order; nothing when none is ticked, which the runtime reads the same. */
export function agentsRequest(agents: readonly ProjectAgent[], ticked: ReadonlySet<string>): string[] | undefined {
  const chosen = agents.filter(a => ticked.has(a.agent)).map(a => a.agent);
  return chosen.length === 0 ? undefined : chosen;
}

/** What a person answered under the plan: yes to its defaults, or a keep or cut per secret-shaped row. */
export interface ImportAnswers {
  yes?: boolean | undefined;
  keep: readonly string[];
  cut: readonly string[];
}

/** Whether anything may leave this computer: a yes, or an answer to a row; nothing given is the dry run. */
export function importConsented(a: ImportAnswers): boolean {
  return a.yes === true || a.keep.length > 0 || a.cut.length > 0;
}

/** What project.import is asked for: the folder here as given (events echo it), where it lands on the machine,
 * which secret-shaped rows travel as they are or rewritten, whose sessions travel, and whether to replace. */
export interface ProjectImportRequest {
  source: string;
  dest: string;
  carry: string[];
  rewrite: string[];
  agents?: string[];
  replace?: true;
}

/** The one request every client sends from a plan and its ticks; the folder lands at the path it has here, which
 * is where init's road puts a project on the machine it seals. */
export function importRequest(plan: ProjectPlan, source: string, ticked: ReadonlySet<string>, agents: ReadonlySet<string>, replace?: boolean): ProjectImportRequest {
  const travelling = agentsRequest(plan.agents, agents);
  return { source, dest: plan.source, ...consentRequest(plan.secrets, ticked), ...(travelling !== undefined ? { agents: travelling } : {}), ...(replace === true ? { replace: true } : {}) };
}

/** The row's words for its tick, short for the row's end and full for its title: left out, travels as is, or rewritten
 * without its keys, the full form naming what the remote then reads and which config keys are left out. */
export function secretOffer(s: ProjectSecret, ticked: boolean): { short: string; full: string } {
  if (!ticked) return { short: "left out", full: "left out" };
  if (s.rewrite === undefined) return { short: "travels as is", full: "travels as is" };
  const short = "rewritten without keys";
  const remote = s.rewrite.urls.length > 0 ? `; the remote reads ${s.rewrite.urls.join(", ")}` : "";
  const dropped = s.rewrite.drop.length > 0 ? `; ${s.rewrite.drop.join(", ")} left out` : "";
  return { short, full: `${short}${remote}${dropped}` };
}
