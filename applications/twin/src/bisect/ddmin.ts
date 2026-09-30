/**
 * Zeller's ddmin: finds a 1-minimal subset of `items` for which `test` still fails. "1-minimal"
 * means removing any single remaining item makes the failure go away. Anything other than 'fail'
 * (a pass, a different failure, flakiness) counts as "does not fail", which keeps the search
 * conservative: an unclear trial never shrinks the set.
 */

export type TrialResult = 'fail' | 'pass' | 'unresolved';

export type TrialFn<T> = (subset: readonly T[]) => Promise<TrialResult>;

export interface DdminResult<T> {
  minimal: T[];
  /** Distinct subsets actually tested (cached repeats are not counted). */
  trials: number;
}

function split<T>(items: readonly T[], parts: number): T[][] {
  const chunks: T[][] = [];
  let start = 0;
  for (let i = 0; i < parts; i++) {
    const end = start + Math.ceil((items.length - start) / (parts - i));
    chunks.push(items.slice(start, end));
    start = end;
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * `key` identifies an item for caching (subsets are cached by the sorted keys they contain).
 * The caller is expected to have checked that the full set fails.
 */
export async function ddmin<T>(
  items: readonly T[],
  test: TrialFn<T>,
  key: (item: T) => string,
): Promise<DdminResult<T>> {
  const cache = new Map<string, TrialResult>();
  const run = async (subset: readonly T[]): Promise<TrialResult> => {
    const id = subset.map(key).sort().join('\u0000');
    const cached = cache.get(id);
    if (cached) return cached;
    const result = await test(subset);
    cache.set(id, result);
    return result;
  };

  let current = [...items];
  let granularity = 2;
  while (current.length >= 2) {
    const chunks = split(current, granularity);
    let reduced = false;

    for (const chunk of chunks) {
      if ((await run(chunk)) === 'fail') {
        current = chunk;
        granularity = 2;
        reduced = true;
        break;
      }
    }
    if (!reduced && chunks.length > 2) {
      for (const chunk of chunks) {
        const complement = current.filter((item) => !chunk.includes(item));
        if ((await run(complement)) === 'fail') {
          current = complement;
          granularity = Math.max(granularity - 1, 2);
          reduced = true;
          break;
        }
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return { minimal: current, trials: cache.size };
}
