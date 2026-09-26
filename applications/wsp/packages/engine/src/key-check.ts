// SPDX-License-Identifier: AGPL-3.0-only
// Whether the provider takes a key, and the three answers that question has:
// taken, refused in the provider's own words, or never answered at all. Asked
// before a key is saved and again before the build's first call to the
// provider, so a refusal is read on the step that can fix it.
import { keyRefusedLine, keyUncheckedLine, providerSaidLine, savedKeyRefusedLine } from "@wsp/protocol";
import type { ErrorKind, WspError } from "./errors.js";
import type { MachineBackend } from "./machine.js";

export type KeyCheck =
  | { state: "taken" }
  /** The provider answered about the key itself and refused it; `said` is its own status and word. */
  | { state: "refused"; said: string }
  /** Nothing came back about the key; `said` is what this computer saw instead. */
  | { state: "unchecked"; said: string };

/** The statuses that answer about the key and nothing else: the token is not one the provider knows, or the plan
 * behind it may not do this. Every other failure answered about something else, or never answered, and calling the
 * key refused on one of those would be a guess. */
const REFUSING: ReadonlySet<ErrorKind> = new Set<ErrorKind>(["auth", "plan"]);

export async function checkProviderKey(backend: MachineBackend): Promise<KeyCheck> {
  if (backend.checkKey === undefined) return { state: "taken" };
  try {
    await backend.checkKey();
    return { state: "taken" };
  } catch (e) {
    const err = e as Partial<WspError>;
    if (err.kind !== undefined && err.status !== undefined && REFUSING.has(err.kind)) return { state: "refused", said: providerSaidLine(err.status, err.message ?? "") };
    return { state: "unchecked", said: e instanceof Error ? e.message : String(e) };
  }
}

/** The check as one line a person reads, naming the provider it asked by its id, in the words of the step that asked:
 * `saved` is the build reading a key already in the file, and anything else is the keys step reading what was just
 * typed. */
export function keyCheckLine(check: KeyCheck, provider: string, saved = false): string | undefined {
  if (check.state === "taken") return undefined;
  if (check.state === "unchecked") return keyUncheckedLine(check.said, provider);
  return saved ? savedKeyRefusedLine(check.said, provider) : keyRefusedLine(check.said, provider);
}
