// SPDX-License-Identifier: AGPL-3.0-only
// The canvas font-family list the terminal draws with: the chosen face, the
// installed faces the desktop shell handed over for it, then the bundled
// symbols face for every glyph the others lack. No face is named here that
// the person or their computer did not name first.
import { cssFontFamilies } from "../../appearanceFonts";

// The platform's own monospace faces; concrete names only, because an
// unknown keyword (like ui-monospace) makes canvas font shorthand parsing
// reject the whole string.
export const DEFAULT_TERMINAL_TEXT_FACES = '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono"';

/** The bundled symbols-only Nerd Font: it carries no letters, so it changes no metrics wherever it sits. */
export const TERMINAL_SYMBOLS_FACE = "Symbols Nerd Font Mono";

const bare = (name: string): string => name.trim().replace(/^(['"])(.*)\1$/, "$2").toLowerCase();

/** Every family a list names, unquoted and lowercased, for telling duplicates apart. */
function familiesNamed(list: string): Set<string> {
  return new Set(
    list
      .split(",")
      .map(bare)
      .filter((name) => name.length > 0),
  );
}

export function terminalFontChain(family: string | undefined, locals: readonly string[] = []): string {
  const chosen = family === undefined ? null : cssFontFamilies(family);
  const head = chosen ?? DEFAULT_TERMINAL_TEXT_FACES;
  const named = familiesNamed(head);
  const parts = [head];
  for (const local of locals) {
    const quoted = cssFontFamilies(local);
    if (quoted === null || named.has(bare(local))) continue;
    named.add(bare(local));
    parts.push(quoted);
  }
  if (!named.has(TERMINAL_SYMBOLS_FACE.toLowerCase())) parts.push(`"${TERMINAL_SYMBOLS_FACE}"`);
  parts.push("monospace");
  return parts.join(", ");
}
