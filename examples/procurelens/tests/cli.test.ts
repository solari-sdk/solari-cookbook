import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const cli = (...args: string[]) => execFileSync(process.execPath, ['--experimental-strip-types', 'src/cli.ts', ...args], { cwd, encoding: 'utf8', timeout: 15000 });
test('CLI plans offline, simulates, verifies, reports and compares observations', () => {
  assert.equal(JSON.parse(cli('plan', 'fixtures/internal.json', 'https://www.adafruit.com/product/385')).browserSessions, 1);
  const a = cli('simulate', 'fixtures/internal.json', 'fixtures/source-a.json').trim().split('\n').at(-1)!.trim();
  const b = cli('simulate', 'fixtures/internal.json', 'fixtures/source-b.json').trim().split('\n').at(-1)!.trim();
  assert.match(cli('verify', `${a}/run.json`), /INTEGRITY_VALID SIMULATION REVIEW_REQUIRED/);
  assert.match(cli('report', `${a}/run.json`), /runs/);
  const comparison = cli('compare', `${a}/run.json`, `${b}/run.json`).trim();
  assert.match(readFileSync(`${comparison}/report.html`, 'utf8'), /7.75%/);
  assert.match(cli('verify', `${comparison}/run.json`), /INTEGRITY_VALID SIMULATION COMPARISON/);
  assert.throws(() => cli('compare', `${b}/run.json`, `${a}/run.json`));
});
