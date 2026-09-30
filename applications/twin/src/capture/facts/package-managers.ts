import { readFile } from 'node:fs/promises';
import type { Ecosystem, PackageManagerFact } from '../../capsule/schema.ts';
import { findUp, readJsonFile, toPosixRelative } from '../../util/fs.ts';
import { sha256Hex } from '../../util/hash.ts';

interface ManagerSpec {
  name: string;
  ecosystem: Ecosystem;
  lockfiles: readonly string[];
  /** Key in the probed runtimes/tools that holds this manager's version. */
  versionKey: string;
}

export const MANAGERS: readonly ManagerSpec[] = [
  {
    name: 'npm',
    ecosystem: 'node',
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    versionKey: 'npm',
  },
  { name: 'pnpm', ecosystem: 'node', lockfiles: ['pnpm-lock.yaml'], versionKey: 'pnpm' },
  { name: 'yarn', ecosystem: 'node', lockfiles: ['yarn.lock'], versionKey: 'yarn' },
  { name: 'bun', ecosystem: 'node', lockfiles: ['bun.lock', 'bun.lockb'], versionKey: 'bun' },
  { name: 'uv', ecosystem: 'python', lockfiles: ['uv.lock'], versionKey: 'uv' },
  { name: 'poetry', ecosystem: 'python', lockfiles: ['poetry.lock'], versionKey: 'poetry' },
  { name: 'pipenv', ecosystem: 'python', lockfiles: ['Pipfile.lock'], versionKey: 'pipenv' },
  { name: 'cargo', ecosystem: 'rust', lockfiles: ['Cargo.lock'], versionKey: 'cargo' },
  { name: 'go', ecosystem: 'go', lockfiles: ['go.sum'], versionKey: 'go' },
];

/** Parses package.json "packageManager", e.g. "pnpm@9.12.0+sha512.abc" -> pnpm, 9.12.0. */
export function parseDeclaredManager(field: unknown): { name: string; version: string } | null {
  if (typeof field !== 'string') return null;
  const match = field.match(/^(@?[^@]+)@(\d[^+\s]*)/);
  return match?.[1] && match[2] ? { name: match[1], version: match[2] } : null;
}

async function readDeclared(cwd: string, root: string) {
  const packageJson = await findUp('package.json', cwd, root);
  if (!packageJson) return { hasPackageJson: false, declared: null };
  try {
    const json = (await readJsonFile(packageJson)) as { packageManager?: unknown };
    return { hasPackageJson: true, declared: parseDeclaredManager(json.packageManager) };
  } catch {
    return { hasPackageJson: true, declared: null };
  }
}

async function findLockfile(spec: ManagerSpec, cwd: string, root: string): Promise<string | null> {
  for (const name of spec.lockfiles) {
    const found = await findUp(name, cwd, root);
    if (found) return found;
  }
  return null;
}

export interface DetectOptions {
  cwd: string;
  /** Repo root (or cwd outside a repo); lockfile search stops here. */
  root: string;
  /** Versions from the probes, keyed by probe name. */
  versions: Readonly<Record<string, string>>;
}

/**
 * Finds the package managers a project uses from lockfiles between cwd and the repo root, plus the
 * package.json "packageManager" pin. A project can use several (e.g. pnpm and uv).
 */
export async function detectPackageManagers(options: DetectOptions): Promise<PackageManagerFact[]> {
  const { cwd, root, versions } = options;
  const { hasPackageJson, declared } = await readDeclared(cwd, root);
  const facts: PackageManagerFact[] = [];

  for (const spec of MANAGERS) {
    const lockfile = await findLockfile(spec, cwd, root);
    const isDeclared = declared?.name === spec.name;
    if (!lockfile && !isDeclared) continue;
    facts.push({
      name: spec.name,
      ecosystem: spec.ecosystem,
      version: versions[spec.versionKey] ?? null,
      declared: isDeclared ? (declared?.version ?? null) : null,
      lockfile: lockfile ? toPosixRelative(root, lockfile) : null,
      lockfileSha256: lockfile ? sha256Hex(await readFile(lockfile)) : null,
    });
  }

  // A package.json with no lockfile and no pin is installed with npm by default.
  if (hasPackageJson && !facts.some((fact) => fact.ecosystem === 'node')) {
    facts.unshift({
      name: 'npm',
      ecosystem: 'node',
      version: versions.npm ?? null,
      declared: null,
      lockfile: null,
      lockfileSha256: null,
    });
  }
  return facts;
}
