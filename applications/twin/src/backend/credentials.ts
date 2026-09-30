import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { ancestors } from '../util/fs.ts';

/** The only variables twin takes from a .env file. */
const SOLARI_KEYS = ['SOLARI_API_KEY', 'SOLARI_BASE_URL'] as const;

export interface SolariEnv {
  SOLARI_API_KEY?: string;
  SOLARI_BASE_URL?: string;
}

/**
 * Solari settings from the environment, falling back to the nearest `.env` file above `cwd` that
 * sets SOLARI_API_KEY (so an app's own .env in a subfolder does not hide the project's). Both keys
 * come from that one file, so a base URL is never paired with a key from somewhere else.
 * Only the Solari keys are read, and they are returned, never put into the process environment:
 * capture records the environment and hands it to the command, so a .env must not leak into it.
 * A variable set in the environment wins over the file.
 */
export async function solariEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<SolariEnv> {
  const fromEnv: SolariEnv = {};
  for (const key of SOLARI_KEYS) if (env[key]) fromEnv[key] = env[key];
  if (fromEnv.SOLARI_API_KEY) return fromEnv;

  for (const dir of ancestors(cwd)) {
    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(await readTextFile(join(dir, '.env'))) as Record<string, string>;
    } catch {
      continue; // missing or unreadable
    }
    if (!parsed.SOLARI_API_KEY) continue;
    const fromFile: SolariEnv = {};
    for (const key of SOLARI_KEYS) if (parsed[key]) fromFile[key] = parsed[key];
    return { ...fromFile, ...fromEnv };
  }
  return fromEnv;
}
