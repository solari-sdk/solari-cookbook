import type { OsFact } from '../../capsule/schema.ts';
import type { Host } from '../../host.ts';
import { firstVersion } from './probes.ts';

/** Parses /etc/os-release (KEY=value lines, values optionally quoted). */
export function parseOsRelease(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match?.[1] || match[2] === undefined) continue;
    fields[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return fields;
}

async function linuxDistro(host: Host): Promise<Pick<OsFact, 'distro' | 'distroVersion'>> {
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      const fields = parseOsRelease(await host.readTextFile(path));
      return { distro: fields.ID ?? null, distroVersion: fields.VERSION_ID ?? null };
    } catch {
      // Try the next location.
    }
  }
  return { distro: null, distroVersion: null };
}

async function linuxLibc(host: Host): Promise<Pick<OsFact, 'libc' | 'libcVersion'>> {
  const glibc = host.glibcVersion();
  if (glibc) return { libc: 'glibc', libcVersion: glibc };
  // musl's ldd prints "musl libc (x86_64)\nVersion 1.2.4" to stderr and exits non-zero.
  const ldd = await host.exec(['ldd', '--version'], { timeoutMs: 5_000 });
  const output = `${ldd.stdout}\n${ldd.stderr}`;
  if (/musl/i.test(output)) return { libc: 'musl', libcVersion: firstVersion(output) };
  return { libc: null, libcVersion: null };
}

async function macosVersion(host: Host): Promise<string | null> {
  const result = await host.exec(['sw_vers', '-productVersion'], { timeoutMs: 5_000 });
  return result.ok ? result.stdout.trim() || null : null;
}

export async function collectOs(host: Host): Promise<OsFact> {
  const base = { platform: host.platform, arch: host.arch, release: host.osRelease };
  switch (host.platform) {
    case 'linux':
      return { ...base, ...(await linuxDistro(host)), ...(await linuxLibc(host)) };
    case 'darwin':
      return {
        ...base,
        distro: 'macos',
        distroVersion: await macosVersion(host),
        libc: null,
        libcVersion: null,
      };
    default:
      return { ...base, distro: null, distroVersion: null, libc: null, libcVersion: null };
  }
}
