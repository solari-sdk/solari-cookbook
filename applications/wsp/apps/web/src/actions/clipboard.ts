// SPDX-License-Identifier: AGPL-3.0-only
// The one clipboard write every copy action uses; a page without the
// clipboard api says so in the action's own toast rather than failing quietly.

export const NO_CLIPBOARD = "The clipboard is not available here";

export function copyText(text: string): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") return Promise.reject(new Error(NO_CLIPBOARD));
  return clipboard.writeText(text);
}
