import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workerUrl = new URL('../../static-broker/worker.js', import.meta.url);
const readmeUrl = new URL('../../static-broker/README.md', import.meta.url);

async function text(url) {
  return readFile(url, 'utf8');
}

test('optional broker remains allowlisted and origin bounded', async () => {
  const worker = await text(workerUrl);
  assert.match(worker, /PUBLIC_SOURCE_HOSTS/);
  assert.match(worker, /ALLOWED_ORIGIN/);
  assert.match(worker, /url\.hostname !== allowedHost/);
  assert.match(worker, /finalUrl\.hostname !== allowedHost/);
  assert.match(worker, /request_too_large/);
  assert.match(worker, /upstream_response_too_large/);
  assert.doesNotMatch(worker, /Access-Control-Allow-Origin['"]\s*:\s*['"]\*/);
});

test('credential delegation is path bounded and never browser supplied', async () => {
  const worker = await text(workerUrl);
  assert.match(worker, /DELEGATE_BASE_URL/);
  assert.match(worker, /DELEGATE_AUTHORIZATION/);
  assert.match(worker, /target\.origin !== base\.origin/);
  assert.match(worker, /cleanPath\.includes\('\.\.'\)/);
  assert.match(worker, /Authorization: authorization/);
  assert.doesNotMatch(worker, /payload\.authorization/);
});

test('broker documentation preserves no-hosting boundary', async () => {
  const readme = await text(readmeUrl);
  assert.match(readme, /not\*\* a replacement application backend/i);
  assert.match(readme, /no database/i);
  assert.match(readme, /does not hard-code a broker address/i);
  assert.match(readme, /Do not turn the broker into an open proxy/i);
});
