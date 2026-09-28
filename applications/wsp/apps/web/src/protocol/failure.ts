// SPDX-License-Identifier: AGPL-3.0-only
import { refusalParts } from "@wsp/protocol";
import { DisconnectedError, NO_REASON } from "./client.js";

/** A failure as the app shows it: what happened, what to do about it when the host said, the kind it was stamped
 * with, and whether no socket carried the request at all. */
export interface Failure {
  said: string;
  fix: string | undefined;
  kind: string | undefined;
  disconnected: boolean;
}

/** Reads any rejection into a Failure. The host joins the two halves into one sentence for a terminal, so `said` is
 * that sentence with its fix taken back off the end. */
export function failureOf(e: unknown): Failure {
  if (!(e instanceof Error)) return { said: e == null ? NO_REASON : String(e), fix: undefined, kind: undefined, disconnected: false };
  return { ...refusalParts(e), disconnected: e instanceof DisconnectedError };
}
