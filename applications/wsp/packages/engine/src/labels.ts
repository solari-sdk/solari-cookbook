// SPDX-License-Identifier: AGPL-3.0-only
// The metadata keys wsp stamps on every machine it creates, in one place with
// no imports, so the builder, the sweep and the fork read the same names.

/** Every machine wsp makes wears this; the sweep never touches one without it. */
export const WSP_LABEL = "wsp";
export const BUILDER_LABEL = "wsp-builder";
export const SMOKE_LABEL = "wsp-smoke";
/** A workspace the app or wsp init forked; a doctor run's throwaway workspace. */
export const HOST_LABEL = "wsp-host";
export const DOCTOR_LABEL = "wsp-doctor";
/** Which state file made a machine. Stamped at creation, so unlike the provider's createdAt it survives a resume; a
 * sweep from another state file reads it and leaves the machine alone. */
export const OWNER_LABEL = "wsp-owner";
/** The record a workspace fork stands for, stamped so a machine that outlives its record can be recorded again. */
export const WORKSPACE_LABEL = "wsp-workspace";
export const NAME_LABEL = "wsp-name";
export const GOLDEN_LABEL = "wsp-golden";
/** When wsp asked for the machine, stamped by our clock: the provider's own createdAt moves on a running machine
 * (measured), so every age a sweep reads comes from this key. */
export const CREATED_AT_LABEL = "createdAt";
/** Sleeping experiments on the account wear this label; the reaper never touches one, even when it also wears ours. */
export const RESERVED_LABEL = "poc";

/** A machine no sweep, doctor or cleanup may touch, whatever else it wears. */
export function isReserved(labels: Record<string, string>): boolean {
  return RESERVED_LABEL in labels;
}
