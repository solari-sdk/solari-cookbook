// SPDX-License-Identifier: AGPL-3.0-only
// A terminal line as spans for the build's stage block: the machine's own
// ANSI colours honoured (the eight colours and their bright pair, bold, dim),
// everything else left to the block's muted foreground. The colours are the
// terminal pane's own sixteen slots, the app's ghostty theme as tokens.css
// carries it, so the block and the pane agree. Codes the block has no colour
// for are dropped, never shown.

export interface AnsiSpan {
  text: string;
  className?: string;
}

/** The class for palette slot n of the terminal's sixteen, the pane's own tokens; the theme swaps them under it. */
const slot = (n: number): string => `text-[var(--terminal-ansi-${n})]`;

const SGR = /\[([\d;]*)m/g;

export function ansiSpans(line: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let colour: string | undefined;
  let bold = false;
  let dim = false;
  let at = 0;
  const push = (text: string): void => {
    if (text === "") return;
    const classes = [colour, bold ? "font-medium" : undefined, dim ? "opacity-60" : undefined].filter((c): c is string => c !== undefined);
    spans.push(classes.length > 0 ? { text, className: classes.join(" ") } : { text });
  };
  for (const m of line.matchAll(SGR)) {
    push(line.slice(at, m.index));
    at = m.index + m[0].length;
    for (const code of (m[1] === "" ? "0" : m[1]!).split(";").map(Number)) {
      if (code === 0) {
        colour = undefined;
        bold = false;
        dim = false;
      } else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 39) colour = undefined;
      else if (code >= 30 && code <= 37) colour = slot(code - 30);
      else if (code >= 90 && code <= 97) colour = slot(code - 90 + 8);
    }
  }
  push(line.slice(at));
  return spans;
}

const PREFIX = /^[a-z][\w-]*:(?=\s)/;

/** The line split into the tool's own prefix (`pnpm:`), the part the block dims, and the rest, when it has one. */
export function toolPrefix(line: string): { prefix: string; rest: string } | undefined {
  const m = PREFIX.exec(line);
  return m === null ? undefined : { prefix: m[0], rest: line.slice(m[0].length) };
}
