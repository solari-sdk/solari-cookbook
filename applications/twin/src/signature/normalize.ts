/**
 * Normalizes command output so the same failure on two machines yields the same lines: strips
 * terminal escapes and replaces volatile tokens (times, durations, paths, addresses, ports).
 * Each replacement is ordered so broader patterns do not swallow narrower ones.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

type Replacement = string | ((match: string) => string);

const REPLACEMENTS: readonly [RegExp, Replacement][] = [
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>'],
  [/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b0x[0-9a-f]+\b/gi, '<hex>'],
  // Hashes contain a letter; all-digit runs are numbers (e.g. timestamps in an assertion) and stay.
  [/\b(?=[0-9]*[a-f])[0-9a-f]{12,}\b/gi, '<hash>'],
  // Absolute paths keep only their last segment: the checkout location differs per machine.
  // Relative paths (src/a.ts) are already machine-independent and are left alone.
  [
    /(?<![\w.-])(?:~|[A-Za-z]:)?(?:[/\\][\w.@+~-]+){2,}/g,
    (path) => `<path>/${path.split(/[/\\]/).at(-1)}`,
  ],
  [/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/g, '$1:<port>'],
  [/\bpid[:= ]\s*\d+/gi, 'pid <n>'],
  [/\b\d+(?:\.\d+)?\s?(?:ns|µs|us|ms|s|sec|secs|seconds?|m|min|mins|minutes?|h)\b/g, '<duration>'],
  // Test runners add "(1.2 s)" only when something was slow, so the whole group is cosmetic.
  [/\s*\(<duration>\)/g, ''],
];

// Runtime-internal locations and version trailers change between releases without meaning anything
// about the failure (Node prints "node:internal/..." headers and "Node.js v22.3.0" after a crash).
// Host configuration warnings (an unresolvable ${TOKEN} in ~/.npmrc, a locale the machine lacks)
// describe the machine, not the failure, and would make the same failure differ per host.
const NOISE_LINE =
  /node:internal\/|^\s*at (?:process\.processTicksAndRejections|async Promise\.all)|^Node\.js v\d|^\S*\s*WARN\s+Issue while reading .*\.npmrc|setlocale: LC_\w+: cannot change locale/;

export function normalizeLine(raw: string): string {
  let line = raw.replace(ANSI, '');
  // Progress bars redraw with \r; only the final state of the line is meaningful.
  line = line.slice(line.lastIndexOf('\r') + 1);
  for (const [pattern, replacement] of REPLACEMENTS) {
    // Narrowed per branch so each call matches a String.replace overload.
    line =
      typeof replacement === 'string'
        ? line.replace(pattern, replacement)
        : line.replace(pattern, replacement);
  }
  return line.replace(/\s+/g, ' ').trim();
}

export function normalizeOutput(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !NOISE_LINE.test(line))
    .map(normalizeLine)
    .filter((line) => line.length > 0);
}
