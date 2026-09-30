import { resolve } from 'node:path';
import { TwinError } from '../errors.ts';
import { parseCapsule, readCapsule } from './file.ts';
import type { Capsule } from './schema.ts';

/** Capsules are a few KB; anything far larger is not one. */
const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface CapsuleSourceOptions {
  cwd: string;
  fetch: typeof globalThis.fetch;
}

export function isCapsuleUrl(source: string): boolean {
  return /^https:\/\//i.test(source);
}

async function fetchCapsule(url: string, fetch: typeof globalThis.fetch): Promise<Capsule> {
  let response: Response;
  try {
    // Issue attachments redirect to signed storage URLs; fetch follows them.
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new TwinError(`cannot download ${url}: ${(error as Error).message}`, { cause: error });
  }
  if (!response.ok) throw new TwinError(`cannot download ${url}: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new TwinError(`${url} is too large to be a capsule`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new TwinError(`${url} is too large to be a capsule`);
  return parseCapsule(text, url);
}

/** Reads a capsule from a local path (relative to cwd) or an https URL such as an issue attachment. */
export async function loadCapsule(source: string, options: CapsuleSourceOptions): Promise<Capsule> {
  if (isCapsuleUrl(source)) return fetchCapsule(source, options.fetch);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    throw new TwinError(`only https URLs are supported for capsules: ${source}`, { exitCode: 2 });
  }
  return readCapsule(resolve(options.cwd, source));
}
