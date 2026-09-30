import { readFile, writeFile } from 'node:fs/promises';
import { TwinError } from '../errors.ts';
import { DecodeError } from './decode.ts';
import { type Capsule, decodeCapsule } from './schema.ts';

export function serializeCapsule(capsule: Capsule): string {
  return `${JSON.stringify(capsule, null, 2)}\n`;
}

export function parseCapsule(text: string, source: string): Capsule {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new TwinError(`${source} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  try {
    return decodeCapsule(json);
  } catch (error) {
    if (error instanceof DecodeError) {
      throw new TwinError(`${source} is not a valid twin capsule (${error.message})`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function readCapsule(path: string): Promise<Capsule> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new TwinError(`cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? error}`, {
      cause: error,
    });
  }
  return parseCapsule(text, path);
}

export async function writeCapsule(path: string, capsule: Capsule): Promise<number> {
  const text = serializeCapsule(capsule);
  try {
    await writeFile(path, text, 'utf8');
  } catch (error) {
    throw new TwinError(`cannot write ${path}: ${(error as NodeJS.ErrnoException).code ?? error}`, {
      cause: error,
    });
  }
  return Buffer.byteLength(text);
}
