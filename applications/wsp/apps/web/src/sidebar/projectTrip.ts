// SPDX-License-Identifier: AGPL-3.0-only
// What both project trips, the import and the export, compute from the wire:
// a folder's own name, a counted word, an agent's catalog name, each agent's
// outcome in the one set of words the web has for it, the refusal a caught
// error becomes with the tone the status line gives it, and what the one slot
// says out of what the trip has. No React here.
import { agentName } from "@wsp/catalog";
import { plural, type ProjectAgentOutcome, type ProjectAgentResult, type TripProgress } from "@wsp/protocol";
import { errorText } from "../lib/utils.js";
import { RequestError } from "../protocol/client.js";

/** The protocol's rule under the name this folder's files already call it by; there is one implementation. */
export const count = plural;

export { folderName } from "@wsp/protocol";

/** The web's one set of words for what became of an agent's sessions, short enough for a row's end. */
const OUTCOME_WORDS: Record<Exclude<ProjectAgentOutcome, "failed">, string> = {
  moved: "moved",
  "transcript-only": "transcripts landed, not yet listed",
  carried: "carried unchanged",
  nothing: "nothing to bring",
};

/** What became of one agent's sessions: the outcome's words, then the indexed rollouts the trip had to skip. */
export function agentOutcome(a: ProjectAgentResult): string {
  if (a.outcome === "failed") return `failed: ${a.error ?? "no reason given"}`;
  const skipped = a.skipped === undefined || a.skipped === 0 ? "" : `, ${count(a.skipped, "rollout")} skipped`;
  return `${OUTCOME_WORDS[a.outcome]}${skipped}`;
}

/** Every agent by name with its outcome, comma-joined for a landed line; the session counts stay with the rows and the
 * runtime's done sentence. */
export function agentOutcomes(agents: readonly ProjectAgentResult[]): string {
  return agents.map(a => `${agentName(a.agent)} ${agentOutcome(a)}`).join(", ");
}

export interface Refusal {
  readonly message: string;
  /** The destination already exists; the one follow-up is to replace it. */
  readonly exists: boolean;
}

/** The slot's voice: a step under way in muted mono, a quiet sentence, a caution that asks for a replace, an error. */
export type StatusTone = "step" | "quiet" | "caution" | "error";

/** A caught error as the trip's refusal: the runtime's `exists` kind is the one with a follow-up. */
export const refusalOf = (e: unknown): Refusal => ({ message: errorText(e), exists: e instanceof RequestError && e.kind === "exists" });

/** A refusal that asks for a replace is a caution, any other an error; none is quiet. */
export const refusalTone = (refusal: Refusal | null): StatusTone => (refusal === null ? "quiet" : refusal.exists ? "caution" : "error");

/** What the slot says: a refusal in its tone before anything, then the landed line, then the step under way, else the
 * trip's idle words. */
export function slotWords({ refusal, landed, progress, idle }: { refusal: Refusal | null; landed: string | null; progress: TripProgress | null; idle: string }): { words: string; tone: StatusTone } {
  if (refusal !== null) return { words: refusal.message, tone: refusalTone(refusal) };
  if (landed !== null) return { words: landed, tone: "quiet" };
  if (progress !== null) return { words: progress.line, tone: "step" };
  return { words: idle, tone: "quiet" };
}
