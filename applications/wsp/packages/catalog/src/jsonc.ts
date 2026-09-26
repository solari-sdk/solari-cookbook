// SPDX-License-Identifier: AGPL-3.0-only
// JSON with the comments Gemini CLI and OpenCode accept in their settings,
// and the trailing commas a hand-edited file tends to carry. One reader for
// everything that opens an agent's config, to list its servers or place one.

export interface Jsonc {
  value: unknown;
}

/** The value the text holds; a real syntax error throws as JSON.parse does. One pass
 * over the text that copies its spans, since an agent's config runs to tens of megabytes. */
export function readJsonc(text: string): Jsonc {
  const out: string[] = [];
  let from = 0;
  let i = 0;
  /** Where in `out` the last comma stands while only whitespace and comments follow it, else -1. */
  let comma = -1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      comma = -1;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      i++;
    } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      out.push(text.slice(from, i));
      const end = text[i + 1] === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : text[i + 1] === "/" ? end : end + 2;
      from = i;
    } else if (c === ",") {
      out.push(text.slice(from, i));
      comma = out.length;
      out.push(",");
      from = ++i;
    } else {
      if ((c === "}" || c === "]") && comma >= 0) out[comma] = "";
      if (!/\s/.test(c)) comma = -1;
      i++;
    }
  }
  out.push(text.slice(from));
  return { value: JSON.parse(out.join("")) };
}

export const parseJsonc = (text: string): unknown => readJsonc(text).value;
