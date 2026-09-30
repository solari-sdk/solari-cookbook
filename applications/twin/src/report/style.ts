export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

const sgr = (open: number, close: number) => (text: string) =>
  `\u001b[${open}m${text}\u001b[${close}m`;

const identity = (text: string) => text;

export function createStyle(enabled: boolean): Style {
  if (!enabled) {
    return {
      bold: identity,
      dim: identity,
      red: identity,
      green: identity,
      yellow: identity,
      cyan: identity,
    };
  }
  return {
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    red: sgr(31, 39),
    green: sgr(32, 39),
    yellow: sgr(33, 39),
    cyan: sgr(36, 39),
  };
}

/** Color only for terminals, and never when the user opts out (https://no-color.org). */
export function shouldColor(isTTY: boolean, env: NodeJS.ProcessEnv): boolean {
  return isTTY && !env.NO_COLOR && env.TERM !== 'dumb';
}

/** Aligns `key  value` rows under a section heading. */
export function section(style: Style, title: string, rows: readonly [string, string][]): string {
  const width = Math.max(0, ...rows.map(([key]) => key.length));
  const body = rows.map(([key, value]) => `  ${style.dim(key.padEnd(width))}  ${value}`);
  return [style.bold(title), ...body].join('\n');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
