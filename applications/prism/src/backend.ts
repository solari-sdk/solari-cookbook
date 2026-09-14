/**
 * Two places a browser can run. The check logic does not know which it got.
 *
 * `local`  -- Playwright on this machine. Needs no key, so the whole demo runs
 *             offline. It is also the control: if local and Solari disagree,
 *             that is a finding.
 * `solari` -- a cloud browser attached to a server-side profile. The point is
 *             not that it is a browser; it is that the SESSION lives on the
 *             server, so a CI run needs only SOLARI_API_KEY and never holds a
 *             credential. A laptop cannot do that: local Playwright needs the
 *             cookie jar to exist somewhere you control.
 */
export type PageProbe = {
  /** testids present on the rendered page. */
  testids: string[]
  title: string
  url: string
}

export type Backend = {
  name: string
  /**
   * Does this error mean "the account is at its cap", as opposed to a real
   * failure? Only the backend knows -- `check()` must not import a specific
   * backend to find out, or it stops being backend-agnostic.
   */
  isBackpressure?: (err: unknown) => boolean
  /** Render `url` as this identity and report what was actually on the page. */
  probe(url: string, cookies: { name: string; value: string }[], label: string): Promise<PageProbe>
  close(): Promise<void>
}

/** Read testids off a live page. Never trust a claim; read the DOM. */
export const EXTRACT = () =>
  Array.from(document.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid")!)
