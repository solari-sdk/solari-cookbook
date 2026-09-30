import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializeCapsule } from '../../src/capsule/file.ts';
import { isCapsuleUrl, loadCapsule } from '../../src/capsule/source.ts';
import { makeCapsule } from '../helpers/capsule.ts';
import { useTempDirs, writeTree } from '../helpers/fakes.ts';

const capsule = makeCapsule();
const respond =
  (body: string, init: ResponseInit = {}): typeof fetch =>
  async () =>
    new Response(body, init);

describe('loadCapsule', () => {
  const tempDir = useTempDirs();

  it('reads paths relative to the working directory', async () => {
    const dir = await tempDir();
    await writeTree(dir, { 'a/c.json': serializeCapsule(capsule) });
    const noFetch = respond('');
    expect(await loadCapsule('a/c.json', { cwd: dir, fetch: noFetch })).toEqual(capsule);
    expect(await loadCapsule(join(dir, 'a/c.json'), { cwd: '/', fetch: noFetch })).toEqual(capsule);
  });

  it('downloads https URLs such as issue attachments', async () => {
    const seen: string[] = [];
    const fetch: typeof globalThis.fetch = async (url) => {
      seen.push(String(url));
      return new Response(serializeCapsule(capsule));
    };
    const url = 'https://github.com/user-attachments/files/1/twin-capsule.json';
    expect(await loadCapsule(url, { cwd: '/', fetch })).toEqual(capsule);
    expect(seen).toEqual([url]);
  });

  it('explains download failures, oversized bodies and other schemes', async () => {
    const url = 'https://example.com/c.json';
    await expect(
      loadCapsule(url, { cwd: '/', fetch: respond('', { status: 404 }) }),
    ).rejects.toThrow('cannot download https://example.com/c.json: HTTP 404');
    const offline: typeof fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    await expect(loadCapsule(url, { cwd: '/', fetch: offline })).rejects.toThrow(
      /cannot download .*ENOTFOUND/,
    );
    const huge = respond('{}', { headers: { 'content-length': String(6 * 1024 * 1024) } });
    await expect(loadCapsule(url, { cwd: '/', fetch: huge })).rejects.toThrow(/too large/);
    await expect(
      loadCapsule(url, { cwd: '/', fetch: respond('x'.repeat(6 * 1024 * 1024)) }),
    ).rejects.toThrow(/too large/);
    await expect(loadCapsule(url, { cwd: '/', fetch: respond('nope') })).rejects.toThrow(
      /https:\/\/example.com\/c.json is not valid JSON/,
    );
    await expect(
      loadCapsule('http://example.com/c.json', { cwd: '/', fetch: respond('') }),
    ).rejects.toThrow('only https URLs are supported');
  });

  it('recognizes https URLs only', () => {
    expect(isCapsuleUrl('HTTPS://x/y.json')).toBe(true);
    expect(isCapsuleUrl('http://x/y.json')).toBe(false);
    expect(isCapsuleUrl('./https.json')).toBe(false);
  });
});
