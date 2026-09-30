import { diffCapsules } from '../capsule/diff.ts';
import type { Capsule, EnvFact } from '../capsule/schema.ts';
import { TwinError } from '../errors.ts';

/**
 * One difference between the good and bad environments that a trial can apply on top of the good
 * world. Bisect searches for the smallest set of atoms that makes the good world fail like the bad.
 */
export type Atom =
  | { kind: 'env'; id: string; label: string; name: string; value: string | null }
  | { kind: 'node'; id: string; label: string; version: string; goodVersion: string | null }
  | { kind: 'dependency'; id: string; label: string; name: string; version: string }
  | { kind: 'diff'; id: string; label: string; diff: string };

/** A difference bisect saw but cannot vary, with the reason. Reported so nothing is hidden. */
export interface Skipped {
  category: string;
  key: string;
  reason: string;
}

export interface AtomSet {
  atoms: Atom[];
  skipped: Skipped[];
  notes: string[];
}

function envAtom(
  name: string,
  good: EnvFact | undefined,
  bad: EnvFact | undefined,
): Atom | Skipped {
  const skip = (reason: string): Skipped => ({ category: 'env', key: name, reason });
  const badState = bad?.state ?? 'absent';
  if (badState === 'set' && bad?.value === undefined) {
    return skip('value not captured on the failing machine (capture with --include-env)');
  }
  if (badState === 'absent') {
    // Replay only sets variables whose value it knows, so an unknown good value is already unset.
    if (good?.value === undefined)
      return skip('unset in the failing environment and not set in replay');
    return { kind: 'env', id: `env:${name}`, label: `unset ${name}`, name, value: null };
  }
  const value = badState === 'empty' ? '' : (bad?.value as string);
  return {
    kind: 'env',
    id: `env:${name}`,
    label: `${name}=${value === '' ? '""' : value}`,
    name,
    value,
  };
}

const UNSUPPORTED: Record<string, string> = {
  os: 'a Linux sandbox cannot vary the operating system',
  tool: 'build tools are not varied',
  packageManager: 'package manager versions are not varied yet',
  pythonDependency: 'python dependencies are not varied yet',
  locale: 'the locale follows LANG/LC_* variables, which are bisected as env',
};

/**
 * Derives bisect atoms from two capsules of the same project and commit. `good` must pass and
 * `bad` must fail; otherwise there is nothing to explain.
 */
export function deriveAtoms(good: Capsule, bad: Capsule): AtomSet {
  if (bad.command.outcome !== 'fail')
    throw new TwinError('the bad capsule did not fail; nothing to bisect', { exitCode: 2 });
  if (good.command.outcome !== 'pass')
    throw new TwinError('the good capsule did not pass; pick a capsule whose command passed', {
      exitCode: 2,
    });
  if (good.repo?.commit !== bad.repo?.commit) {
    throw new TwinError(
      `the capsules are from different commits (${good.repo?.commit ?? 'none'} vs ${bad.repo?.commit ?? 'none'}); bisect compares environments, use git bisect for code changes`,
      { exitCode: 2 },
    );
  }

  const atoms: Atom[] = [];
  const skipped: Skipped[] = [];
  const notes: string[] = [];
  const add = (result: Atom | Skipped) =>
    'kind' in result ? atoms.push(result) : skipped.push(result);
  const npmProject = bad.packageManagers.find((m) => m.ecosystem === 'node')?.name === 'npm';

  for (const difference of diffCapsules(good, bad)) {
    const { category, key } = difference;
    const skip = (reason: string) => skipped.push({ category, key, reason });
    switch (category) {
      case 'env':
        // Without an explicit TZ on the failing side, replay derives TZ from its resolved zone, so
        // the zone (locale atom below) is the real difference, not "TZ is unset".
        if (key === 'TZ' && bad.env.TZ?.value === undefined && bad.locale.timeZone) {
          if (good.locale.timeZone === bad.locale.timeZone) skip('same effective time zone');
          break;
        }
        add(envAtom(key, good.env[key], bad.env[key]));
        break;
      case 'locale':
        // An explicit TZ value in the env already covers the zone; otherwise vary it through TZ.
        if (key === 'timeZone' && bad.locale.timeZone && bad.env.TZ?.value === undefined) {
          atoms.push({
            kind: 'env',
            id: 'env:TZ',
            label: `TZ=${bad.locale.timeZone}`,
            name: 'TZ',
            value: bad.locale.timeZone,
          });
        } else if (key !== 'timeZone') {
          skip(UNSUPPORTED.locale as string);
        }
        break;
      case 'runtime':
        if (key === 'node' && difference.b) {
          atoms.push({
            kind: 'node',
            id: 'node',
            label: `node ${difference.b}`,
            version: difference.b,
            goodVersion: difference.a,
          });
        } else {
          skip(
            difference.b
              ? `${key} versions are not varied yet`
              : `${key} is missing on the failing machine`,
          );
        }
        break;
      case 'nodeDependency': {
        const versions = bad.resolved.node?.[key];
        if (!npmProject) skip('dependency versions are varied only for npm projects so far');
        else if (!versions || versions.length === 0) skip('not installed on the failing machine');
        else if (versions.length > 1) {
          // Several copies are installed (for example lru-cache 5 for babel and 11 for jsdom): vary
          // the one copy that is new on the failing side, if there is exactly one.
          const added = versions.filter((v) => !(good.resolved.node?.[key] ?? []).includes(v));
          if (added.length === 1)
            atoms.push({
              kind: 'dependency',
              id: `dep:${key}`,
              label: `${key}@${added[0]}`,
              name: key,
              version: added[0] as string,
            });
          else skip('several new versions installed on the failing machine');
        } else
          atoms.push({
            kind: 'dependency',
            id: `dep:${key}`,
            label: `${key}@${versions[0]}`,
            name: key,
            version: versions[0] as string,
          });
        break;
      }
      case 'repo':
        if (key === 'working tree diff') {
          atoms.push({
            kind: 'diff',
            id: 'diff',
            label: 'working tree diff',
            diff: bad.repo?.diff ?? '',
          });
          if (bad.repo?.diffRedacted || bad.repo?.diffTruncated)
            notes.push(
              'The failing working tree diff was scrubbed or truncated; applying it may not be exact.',
            );
        } else if (key === 'remote') {
          notes.push("The capsules name different git remotes; the good capsule's remote is used.");
        }
        break;
      default:
        skip(UNSUPPORTED[category] ?? 'not varied');
    }
  }
  return { atoms, skipped, notes };
}
