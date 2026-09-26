// SPDX-License-Identifier: AGPL-3.0-only
// The Disk line under the wizard's screens and on the summary card, and the
// colour a single row's size takes. The thresholds are the protocol's tables,
// the ones the app reads, so the terminal and the app say the same tone for the
// same size and the same share; here they are only mapped onto the terminal's
// three colours. Hue here means weight and nothing else.
import type { DiskEstimate } from "@wsp/engine";
import { diskTone as diskToneOf, fmtBytes, sizeTone as sizeToneOf, type SizeTone } from "@wsp/protocol";
import type { Tone } from "./init-select.js";

/** The protocol's four tones on the terminal's three: danger red, warning bright yellow, yellow yellow, muted plain. */
const TERMINAL_TONE: Record<SizeTone, Tone | undefined> = { danger: "red", warning: "yellowBright", yellow: "yellow", muted: undefined };

/** The colour the Disk line takes against the room: the protocol's disk table, plain under 70 percent, bright yellow
 * from 70, red from 90 and over. */
export function diskTone(total: number, room: number): Tone | undefined {
  return TERMINAL_TONE[diskToneOf(total, room)];
}

/** The colour a row's own size takes on a list: the protocol's size table, plain under 100 MB, yellow from 100,
 * bright yellow from 300, red from a gigabyte. */
export function sizeTone(bytes: number | undefined): Tone | undefined {
  return bytes === undefined ? undefined : TERMINAL_TONE[sizeToneOf(bytes)];
}

/** The estimate's parts that are not zero, and how many rows have no size. */
export function diskParts(est: DiskEstimate): string {
  const parts = ([["files", est.files], ["Homebrew's toolchain", est.toolchain], ["tools", est.tools], ["agents", est.agents]] as const).filter(([, n]) => n > 0).map(([label, n]) => `${label} ${fmtBytes(n)}`);
  const unknown = est.unknown.length > 0 ? `${est.unknown.length} unmeasured, ~${fmtBytes(est.assumed)}` : "";
  return [parts.join(", "), unknown].filter(p => p !== "").join("; ");
}

/** The total against the room the builder's disk leaves. `diskGb` is what the provider gives a builder, where it
 * gives a figure at all: a container's disk is the box's, so there is no room to be over and the line says the
 * total alone. */
export function diskHead(est: DiskEstimate, diskGb?: number): string {
  if (diskGb === undefined) return `${fmtBytes(est.total)} on the machine`;
  return est.over > 0 ? `${fmtBytes(est.total)}, ${fmtBytes(est.over)} over the ${fmtBytes(est.room)} the ${diskGb} GB builder leaves` : `${fmtBytes(est.total)} of ${fmtBytes(est.room)} on the ${diskGb} GB builder`;
}

/** The Disk line: the total, then the parts in brackets. */
export function diskLine(est: DiskEstimate, diskGb?: number): string {
  const parts = diskParts(est);
  const head = diskHead(est, diskGb);
  return parts === "" ? head : `${head} (${parts})`;
}
