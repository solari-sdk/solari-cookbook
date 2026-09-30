import type { PackageManagerFact } from '../capsule/schema.ts';
import { TwinError } from '../errors.ts';
import { shellQuote } from './shell.ts';

/** Everything twin installs or checks out lives under one directory in the guest. */
export const WORK_DIR = '/tmp/twin';
export const TOOLS_DIR = `${WORK_DIR}/tools`;
export const REPO_DIR = `${WORK_DIR}/repo`;
export const VENV_DIR = `${WORK_DIR}/venv`;
/** The capsule's working-tree diff, uploaded during replay setup. */
export const CAPSULE_DIFF_PATH = `${WORK_DIR}/capsule.diff`;
/** A candidate fix under verification, applied on top of the capsule's tree. */
export const FIX_PATCH_PATH = `${WORK_DIR}/fix.patch`;
export const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function nodeDir(version: string): string {
  return `${TOOLS_DIR}/node-${version}`;
}

/** Official Node.js tarball for the guest's architecture. No compiling, cached per version. */
export function installNodeScript(version: string): string[] {
  // The version lands inside a double-quoted URL, where quoting cannot neutralize $(...), and it
  // comes from an untrusted capsule. Real Node versions never need more than these characters.
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) {
    throw new TwinError(`not a node version: ${JSON.stringify(version)}`, { exitCode: 2 });
  }
  const dir = shellQuote(nodeDir(version));
  const v = shellQuote(version);
  return [
    `case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; esac`,
    `if [ ! -x ${dir}/bin/node ]; then`,
    `  mkdir -p ${dir}`,
    `  curl -fsSL "https://nodejs.org/dist/v${v}/node-v${v}-linux-$arch.tar.gz" | tar -xz -C ${dir} --strip-components=1`,
    'fi',
    // Recent Node builds link libatomic, which slim Debian/Ubuntu images do not ship.
    `if ! ${dir}/bin/node --version >/dev/null 2>&1 && command -v apt-get >/dev/null; then`,
    `  sudo=$([ "$(id -u)" = 0 ] || echo sudo)`,
    '  $sudo apt-get update -qq && $sudo apt-get install -y -qq libatomic1 >/dev/null',
    'fi',
    `${dir}/bin/node --version`,
  ];
}

export const UV_DIR = `${TOOLS_DIR}/uv`;

/** Python through uv: it downloads prebuilt interpreters for exact patch versions in seconds. */
export function installPythonScript(version: string): string[] {
  return [
    `if [ ! -x ${UV_DIR}/uv ]; then`,
    `  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=${UV_DIR} UV_NO_MODIFY_PATH=1 sh`,
    'fi',
    `${UV_DIR}/uv venv --python ${shellQuote(version)} ${VENV_DIR}`,
    `${VENV_DIR}/bin/python --version`,
  ];
}

export interface ManagerCommands {
  /** Installs the package manager at the captured version, or null when nothing is needed. */
  setup: string[] | null;
  install: string[];
}

function isYarnClassic(version: string | null): boolean {
  return version === null || version.startsWith('1.');
}

/** How to get a node package manager at the captured version and install dependencies with it. */
export function nodeManagerCommands(manager: PackageManagerFact): ManagerCommands | null {
  const version = manager.version ?? manager.declared;
  const pin = (pkg: string) => (version ? ['npm', 'install', '-g', `${pkg}@${version}`] : null);
  const locked = manager.lockfile !== null;
  switch (manager.name) {
    case 'npm':
      return { setup: pin('npm'), install: locked ? ['npm', 'ci'] : ['npm', 'install'] };
    case 'pnpm':
      return {
        setup: pin('pnpm') ?? ['npm', 'install', '-g', 'pnpm'],
        install: locked ? ['pnpm', 'install', '--frozen-lockfile'] : ['pnpm', 'install'],
      };
    case 'yarn':
      // Yarn 2+ ships as @yarnpkg/cli-dist; the classic "yarn" package stops at 1.x.
      return isYarnClassic(version)
        ? {
            setup: pin('yarn') ?? ['npm', 'install', '-g', 'yarn'],
            install: locked ? ['yarn', 'install', '--frozen-lockfile'] : ['yarn', 'install'],
          }
        : {
            setup: pin('@yarnpkg/cli-dist'),
            install: locked ? ['yarn', 'install', '--immutable'] : ['yarn', 'install'],
          };
    case 'bun':
      return {
        setup: pin('bun') ?? ['npm', 'install', '-g', 'bun'],
        install: locked ? ['bun', 'install', '--frozen-lockfile'] : ['bun', 'install'],
      };
    default:
      return null;
  }
}

/**
 * Dependency install for Python projects into the twin venv, decided in the guest from the files
 * the checkout actually has (the capsule records lockfiles but not requirements files).
 */
export function installPythonDepsScript(): string[] {
  return [
    'if [ -f uv.lock ]; then uv sync --frozen',
    'elif [ -f requirements.txt ]; then uv pip install -r requirements.txt',
    'elif [ -f pyproject.toml ] || [ -f setup.py ]; then uv pip install -e .',
    'else echo "no python dependency manifest found"',
    'fi',
  ];
}
