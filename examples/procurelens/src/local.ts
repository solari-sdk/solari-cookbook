import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bytesHash, type ProcessorInput, type Reconciliation } from './model.ts';

export async function processorFile(): Promise<URL> {
  const source = new URL('../processor.py', import.meta.url);
  try { await readFile(source); return source; }
  catch { return new URL('../../processor.py', import.meta.url); }
}
export async function processorHash(): Promise<string> { return bytesHash(await readFile(await processorFile(), 'utf8')); }
export async function processLocal(input: ProcessorInput, signal?: AbortSignal): Promise<Reconciliation> {
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > 262144) throw new Error('Input too large');
  const path = fileURLToPath(await processorFile());
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PROCURELENS_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), [path], { env, windowsHide: true, timeout: 30000, ...(signal ? { signal } : {}) });
    let output = '', size = 0;
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 524288) child.kill(); else output += chunk.toString('utf8'); });
    child.stderr.resume();
    child.on('error', () => reject(new Error('Local processor unavailable')));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (code !== 0 || size > 524288) return reject(new Error('Local processor failed'));
      try { resolve(JSON.parse(output) as Reconciliation); } catch { reject(new Error('Invalid processor output')); }
    });
    child.stdin.end(payload);
  });
}
