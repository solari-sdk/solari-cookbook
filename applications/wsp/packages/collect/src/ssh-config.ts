// SPDX-License-Identifier: AGPL-3.0-only
// OpenSSH stops reading a config file at the first keyword it does not know,
// and the machine's ssh is not the one on the person's computer: Apple's build
// carries keywords the portable build never had (UseKeychain), and a newer
// build carries keywords an older one lacks (ObscureKeystrokeTiming, OpenSSH
// 9.5), so a copied config can kill every ssh on the machine. IgnoreUnknown at
// the top makes the parser skip what it does not know instead. Measured on
// OpenSSH_9.2p1: a known keyword with a bad argument stays fatal, and the
// directive changes no other value ssh resolves.
export const SSH_CONFIG_PATH = "~/.ssh/config";

/** Said once: the scan's row and the copied file's own header line both read from it. */
const WHY = "ssh on the machine does not know every option yours does, and one unknown option would stop it reading the file";

/** ssh applies IgnoreUnknown from where it stands, so these lines go above everything the file already holds, an
 * Include among them. */
const PRELUDE = `# wsp: ${WHY}.\nIgnoreUnknown *\n`;

/** The ssh config row's line in the scan, so the person reads what the copy gains before it is made. */
export const SSH_IGNORE_UNKNOWN_DETAIL = `copied with IgnoreUnknown at the top, since ${WHY}`;

/** The config as the machine can parse it, the rest of the file untouched. A config that has already been through
 * here is left alone, so a re-import does not stack the line. */
export function withIgnoreUnknown(text: string): string {
  return text.startsWith(PRELUDE) ? text : PRELUDE + text;
}
