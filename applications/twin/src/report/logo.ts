import type { Style } from './style.ts';

/**
 * The site's wordmark for terminals: "twin" in dot-matrix letters (like the Doto face) and a red
 * block cursor as tall as the x-height. Each dot is followed by a space so it reads as square.
 */
const GLYPHS: readonly (readonly string[])[] = [
  [' # ', ' # ', '###', ' # ', ' # ', ' ##'],
  ['     ', '     ', '#   #', '#   #', '# # #', ' # # '],
  ['#', ' ', '#', '#', '#', '#'],
  ['    ', '    ', '### ', '#  #', '#  #', '#  #'],
];
const X_HEIGHT_ROW = 2;
const CURSOR = '████';

const dots = (row: string) => [...row].map((cell) => (cell === '#' ? '●' : ' ')).join(' ');

/** The wordmark, with `beside` lines set to its right from the x-height down. */
export function logo(style: Style, beside: readonly string[] = []): string {
  const rows = (GLYPHS[0] as readonly string[]).map((_, row) => {
    const letters = GLYPHS.map((glyph) => dots(glyph[row] as string)).join('   ');
    const cursor = row >= X_HEIGHT_ROW ? style.red(CURSOR) : ' '.repeat(CURSOR.length);
    const text = beside[row - X_HEIGHT_ROW - 1];
    return `  ${letters}   ${cursor}${text === undefined ? '' : `    ${text}`}`;
  });
  return rows.map((row) => row.trimEnd()).join('\n');
}
