/**
 * Mints one Solari browser session for the whole suite, and releases it after.
 *
 * Without this you would have to POST /sessions by hand and export
 * SOLARI_CDP_ENDPOINT before every run. Playwright starts its workers after
 * globalSetup returns and they inherit this process's environment, so setting
 * the variable here is enough to reach the fixture in solari.ts.
 *
 * Bring your own session by setting SOLARI_CDP_ENDPOINT yourself — CI that
 * already has one should not mint a second.
 */
const API = 'https://api.getsolari.com'

export default async function globalSetup() {
  if (process.env.SOLARI_CDP_ENDPOINT) return // caller supplied one; leave it alone

  const key = process.env.SOLARI_API_KEY
  if (!key) throw new Error('SOLARI_API_KEY is not set — get one at console.getsolari.com')

  const res = await fetch(API + '/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) {
    throw new Error('could not start a Solari session (' + res.status + '): ' + (await res.text()))
  }

  const session = await res.json()
  process.env.SOLARI_CDP_ENDPOINT = session.cdpEndpoint

  // The returned function runs as global teardown. Releasing matters: an
  // orphaned session bills until its idle timeout and holds one of the
  // concurrency slots your plan allows.
  return async () => {
    await fetch(API + '/sessions/' + session.sessionId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + key },
    }).catch(() => {})
  }
}
