import type { DiffCategory, Difference } from '../capsule/diff.ts';
import type { Style } from './style.ts';

const TITLES: Record<DiffCategory, string> = {
  os: 'Operating system',
  runtime: 'Runtimes',
  packageManager: 'Package managers',
  nodeDependency: 'Node packages',
  pythonDependency: 'Python packages',
  env: 'Environment variables',
  locale: 'Locale',
  repo: 'Repository',
  tool: 'Other tools',
};

/** Long dependency lists are summarized; the JSON output keeps every entry. */
const MAX_ROWS_PER_CATEGORY = 25;

function show(value: string | null, style: Style): string {
  return value === null ? style.dim('(absent)') : value;
}

export function renderDifferences(
  differences: readonly Difference[],
  labels: { a: string; b: string },
  style: Style,
): string {
  if (differences.length === 0) return 'No differences in the captured environment.';

  const byCategory = new Map<DiffCategory, Difference[]>();
  for (const diff of differences) {
    byCategory.set(diff.category, [...(byCategory.get(diff.category) ?? []), diff]);
  }

  const blocks = [
    `${style.bold(String(differences.length))} ${differences.length === 1 ? 'difference' : 'differences'}: ${style.red(`- ${labels.a}`)}  ${style.green(`+ ${labels.b}`)}`,
  ];
  for (const [category, diffs] of byCategory) {
    const width = Math.max(...diffs.map((diff) => diff.key.length));
    const rows = diffs
      .slice(0, MAX_ROWS_PER_CATEGORY)
      .map(
        (diff) =>
          `  ${diff.key.padEnd(width)}  ${style.red(`- ${show(diff.a, style)}`)}  ${style.green(`+ ${show(diff.b, style)}`)}`,
      );
    if (diffs.length > MAX_ROWS_PER_CATEGORY) {
      rows.push(style.dim(`  ... ${diffs.length - MAX_ROWS_PER_CATEGORY} more (use --json)`));
    }
    blocks.push([style.bold(`${TITLES[category]} (${diffs.length})`), ...rows].join('\n'));
  }
  return blocks.join('\n\n');
}
