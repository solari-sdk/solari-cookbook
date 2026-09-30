import { describe, expect, it } from 'vitest';
import { ddmin, type TrialResult } from '../../src/bisect/ddmin.ts';

/** Predicate that fails when every culprit is present. */
const failsWhenAll =
  (culprits: string[], onTrial?: (subset: readonly string[]) => void) =>
  async (subset: readonly string[]): Promise<TrialResult> => {
    onTrial?.(subset);
    return culprits.every((c) => subset.includes(c)) ? 'fail' : 'pass';
  };

const letters = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
const id = (x: string) => x;

describe('ddmin', () => {
  it('finds a single culprit among many', async () => {
    const result = await ddmin(letters(8), failsWhenAll(['f']), id);
    expect(result.minimal).toEqual(['f']);
    expect(result.trials).toBeLessThanOrEqual(8);
  });

  it('finds an interacting pair split across halves', async () => {
    const result = await ddmin(letters(8), failsWhenAll(['b', 'g']), id);
    expect(result.minimal.sort()).toEqual(['b', 'g']);
  });

  it('finds three culprits', async () => {
    const result = await ddmin(letters(10), failsWhenAll(['a', 'e', 'j']), id);
    expect(result.minimal.sort()).toEqual(['a', 'e', 'j']);
  });

  it('keeps everything when all items are needed', async () => {
    const result = await ddmin(letters(3), failsWhenAll(letters(3)), id);
    expect(result.minimal.sort()).toEqual(letters(3));
  });

  it('returns a single item without testing', async () => {
    const result = await ddmin(['x'], failsWhenAll(['x']), id);
    expect(result).toEqual({ minimal: ['x'], trials: 0 });
  });

  it('treats unresolved trials as not failing', async () => {
    const result = await ddmin(
      letters(4),
      async (subset) =>
        subset.includes('a') ? 'unresolved' : subset.includes('c') ? 'fail' : 'pass',
      id,
    );
    expect(result.minimal).toEqual(['c']);
  });

  it('never tests the same subset twice', async () => {
    const seen: string[] = [];
    await ddmin(
      letters(8),
      failsWhenAll(['c', 'h'], (subset) => seen.push([...subset].sort().join(''))),
      id,
    );
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('produces a 1-minimal result for random culprit sets', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const items = letters(12);
      const culprits = items.filter((_, i) => (seed * (i + 3)) % 7 === 0);
      if (culprits.length === 0) continue;
      const test = failsWhenAll(culprits);
      const { minimal } = await ddmin(items, test, id);
      expect(await test(minimal)).toBe('fail');
      for (const item of minimal) {
        expect(await test(minimal.filter((x) => x !== item))).toBe('pass');
      }
    }
  });
});
