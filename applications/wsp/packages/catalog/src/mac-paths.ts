// SPDX-License-Identifier: AGPL-3.0-only
// The absolute paths a Mac writes that a Linux image has to answer for: what
// the collector reads out of a config, what the golden import repoints in a
// copied file, and what the MCP plan refuses to run. One table, so the two
// roads cannot drift on which prefix means what.

/** Where Homebrew installs on an Apple Silicon Mac; the image's prefix is BREW_PREFIX. */
export const MAC_BREW = "/opt/homebrew";

/** Absolute prefixes with nothing behind them on the image: an app bundle, the system trees, mounted media, the
 * Mac's own /private, and Homebrew's casks, which are Mac applications however they were installed. */
export const MAC_ONLY: readonly string[] = ["/Applications/", "/System/", "/Library/", "/Volumes/", "/private/", `${MAC_BREW}/Caskroom/`];

/** Homebrew's binary directories: what sits in one is found on the image's own PATH under the same name, whichever
 * road the image installed it by. */
export const MAC_BIN_DIRS: readonly string[] = [`${MAC_BREW}/bin/`, `${MAC_BREW}/sbin/`];
