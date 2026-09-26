// SPDX-License-Identifier: AGPL-3.0-only
/** Polls cond every 10ms until it holds; throws once the deadline passes. */
export async function until(cond: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 10));
  }
}
