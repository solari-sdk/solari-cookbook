import { describe, expect, it } from 'vitest';
import { collectOs, parseOsRelease } from '../../../src/capture/facts/os.ts';
import { failed, fakeExec, fakeHost, ok } from '../../helpers/fakes.ts';

const UBUNTU = `NAME="Ubuntu"
VERSION_ID="24.04"
ID=ubuntu
# comment
PRETTY_NAME='Ubuntu 24.04 LTS'`;

describe('parseOsRelease', () => {
  it('reads quoted and unquoted values', () => {
    expect(parseOsRelease(UBUNTU)).toEqual({
      NAME: 'Ubuntu',
      VERSION_ID: '24.04',
      ID: 'ubuntu',
      PRETTY_NAME: 'Ubuntu 24.04 LTS',
    });
  });
});

describe('collectOs', () => {
  it('describes glibc Linux from os-release', async () => {
    const host = fakeHost({
      readTextFile: async (path) => {
        if (path === '/etc/os-release') return UBUNTU;
        throw new Error('ENOENT');
      },
    });
    expect(await collectOs(host)).toEqual({
      platform: 'linux',
      arch: 'x64',
      release: '6.8.0',
      distro: 'ubuntu',
      distroVersion: '24.04',
      libc: 'glibc',
      libcVersion: '2.39',
    });
  });

  it('detects musl through ldd and falls back to /usr/lib/os-release', async () => {
    const host = fakeHost({
      glibcVersion: () => null,
      exec: fakeExec({ 'ldd --version': failed('musl libc (x86_64)\nVersion 1.2.4') }).exec,
      readTextFile: async (path) => {
        if (path === '/usr/lib/os-release') return 'ID=alpine\nVERSION_ID=3.20.0';
        throw new Error('ENOENT');
      },
    });
    expect(await collectOs(host)).toMatchObject({
      distro: 'alpine',
      distroVersion: '3.20.0',
      libc: 'musl',
      libcVersion: '1.2.4',
    });
  });

  it('leaves unknown Linux details null', async () => {
    const host = fakeHost({ glibcVersion: () => null });
    expect(await collectOs(host)).toMatchObject({
      distro: null,
      distroVersion: null,
      libc: null,
      libcVersion: null,
    });
  });

  it('reads the macOS product version', async () => {
    const host = fakeHost({
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.1.0',
      exec: fakeExec({ 'sw_vers -productVersion': ok('15.1\n') }).exec,
    });
    expect(await collectOs(host)).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      release: '24.1.0',
      distro: 'macos',
      distroVersion: '15.1',
      libc: null,
      libcVersion: null,
    });
  });

  it('reports other platforms without distro details', async () => {
    const host = fakeHost({ platform: 'win32', osRelease: '10.0.22631' });
    expect(await collectOs(host)).toMatchObject({ platform: 'win32', distro: null, libc: null });
  });
});
