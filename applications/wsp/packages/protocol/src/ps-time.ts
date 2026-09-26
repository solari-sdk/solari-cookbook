// SPDX-License-Identifier: AGPL-3.0-only
// The cumulative cpu time ps prints, read once for everything on this computer
// that asks for it: the turn activity clock in the runtime and the processes
// module in the daemon. Neither package may import the other, and a second
// copy of this parser is how the two would drift.

/** Seconds of cpu behind a ps TIME column, `[dd-][hh:]mm:ss[.cc]`: this Mac's ps carries hundredths and Linux's
 * whole seconds, so the same field is read to whatever precision the machine printed. Anything else reads as no
 * cpu at all, since a row that cannot be read must not look like a busy one. */
export function psCpuSeconds(time: string): number {
  const dash = time.indexOf("-");
  const days = dash === -1 ? 0 : Number(time.slice(0, dash));
  let seconds = 0;
  for (const part of time.slice(dash + 1).split(":")) seconds = seconds * 60 + Number(part);
  const total = days * 86_400 + seconds;
  return Number.isFinite(total) && total >= 0 ? total : 0;
}
