import type { Capsule } from '../capsule/schema.ts';
import type { Step } from './plan.ts';
import { WORK_DIR } from './runtimes.ts';
import { script, shellQuote } from './shell.ts';

/**
 * Replay installs from the repo's lockfile, but a failure can come from versions the reporter's
 * install resolved differently (a fresh install, a newer transitive release). After the install,
 * replay lists what the machine has, compares it with the versions the capsule recorded and
 * installs the ones that differ, so the machine holds the reporter's packages.
 */
export const LIST_INSTALLED_PATH = `${WORK_DIR}/list-installed.cjs`;
export const INSTALLED_MARKER = 'TWIN_INSTALLED ';

/**
 * Guest script (plain CommonJS, runs under the replay's own node): the same walk over node_modules
 * that capture does, printing one JSON line of package name to sorted versions.
 */
export const LIST_INSTALLED_SCRIPT = `const fs = require('fs');
const path = require('path');
const cwd = process.argv[2];
const root = process.argv[3];
const seen = new Set();
const versions = {};
function list(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}
function visit(dir) {
  let real;
  try { real = fs.realpathSync(dir); } catch (e) { return; }
  if (seen.has(real) || seen.size >= 50000) return;
  seen.add(real);
  try {
    const json = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
    if (typeof json.name === 'string' && typeof json.version === 'string') {
      if (!versions[json.name]) versions[json.name] = new Set();
      versions[json.name].add(json.version);
    }
  } catch (e) {}
  walk(path.join(real, 'node_modules'));
}
function walk(dir) {
  for (const entry of list(dir)) {
    if (entry.startsWith('@')) {
      for (const scoped of list(path.join(dir, entry))) visit(path.join(dir, entry, scoped));
    } else if (!entry.startsWith('.')) {
      visit(path.join(dir, entry));
    }
  }
}
let dir = cwd;
for (;;) {
  walk(path.join(dir, 'node_modules'));
  if (dir === root || dir === path.dirname(dir)) break;
  dir = path.dirname(dir);
}
const out = {};
for (const name of Object.keys(versions)) out[name] = Array.from(versions[name]).sort();
console.log('${INSTALLED_MARKER}' + JSON.stringify(out));
`;

export function listInstalledArgv(cwd: string, root: string): string[] {
  return script([`node ${LIST_INSTALLED_PATH} ${shellQuote(cwd)} ${shellQuote(root)}`]);
}

/** Reads the script's single JSON line; null when the output has none (the listing failed). */
export function parseInstalled(output: string): Record<string, string[]> | null {
  const line = output.split('\n').find((candidate) => candidate.startsWith(INSTALLED_MARKER));
  if (line === undefined) return null;
  try {
    return JSON.parse(line.slice(INSTALLED_MARKER.length)) as Record<string, string[]>;
  } catch {
    return null;
  }
}

export interface Pin {
  name: string;
  version: string;
}

export interface PinSkip {
  name: string;
  reason: string;
}

export interface PinPlan {
  pins: Pin[];
  skipped: PinSkip[];
}

/**
 * Packages whose recorded versions the machine lacks. Only packages that are installed but at other
 * versions are pinned (a package missing entirely is usually a platform or optional difference).
 * With several new copies of one package there is no single version to install, so it is skipped.
 * `keep` names packages a candidate fix declares: they keep the version the fix resolves.
 */
export function computePins(
  recorded: Readonly<Record<string, readonly string[]>>,
  installed: Readonly<Record<string, readonly string[]>>,
  keep: ReadonlySet<string> = new Set(),
): PinPlan {
  const pins: Pin[] = [];
  const skipped: PinSkip[] = [];
  for (const [name, versions] of Object.entries(recorded)) {
    const have = installed[name];
    if (have === undefined) continue;
    const added = versions.filter((version) => !have.includes(version));
    if (added.length === 0) continue;
    if (keep.has(name)) skipped.push({ name, reason: 'the candidate fix sets this package' });
    else if (added.length > 1) skipped.push({ name, reason: 'several new versions recorded' });
    else pins.push({ name, version: added[0] as string });
  }
  return { pins, skipped };
}

/** Names a patch adds inside a package.json (overrides, dependencies): the fix decides those. */
export function patchedPackageNames(patch: string): Set<string> {
  const names = new Set<string>();
  let inPackageJson = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      inPackageJson = /(?:^|\/)package\.json$/.test(line.slice(4).trim());
    } else if (inPackageJson && /^\+(?!\+\+)/.test(line)) {
      const match = /^\+\s*"([^"]+)"\s*:/.exec(line);
      if (match) names.add(match[1] as string);
    }
  }
  return names;
}

const MAX_TITLE_NAMES = 3;

export function pinStep(pins: readonly Pin[], cwd: string): Extract<Step, { kind: 'run' }> {
  const shown = pins.slice(0, MAX_TITLE_NAMES).map((pin) => `${pin.name}@${pin.version}`);
  const more = pins.length > MAX_TITLE_NAMES ? `, +${pins.length - MAX_TITLE_NAMES} more` : '';
  const noun = pins.length === 1 ? 'package' : 'packages';
  return {
    kind: 'run',
    id: 'pin',
    title: `pin ${pins.length} ${noun} to the capsule's versions (${shown.join(', ')}${more})`,
    argv: script([
      [
        'npm install --no-save --no-audit --no-fund',
        ...pins.map((pin) => shellQuote(`${pin.name}@${pin.version}`)),
      ].join(' '),
    ]),
    cwd,
    timeoutMs: 10 * 60_000,
  };
}

/** Whether the capsule's installed packages can be compared and pinned (npm projects only). */
export function canPin(capsule: Capsule): boolean {
  const manager = capsule.packageManagers.find((m) => m.ecosystem === 'node');
  return manager?.name === 'npm' && capsule.resolved.node !== undefined;
}
