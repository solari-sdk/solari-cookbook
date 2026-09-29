/**
 * The demo app: a small entitlement-gated page, and the request handler for it.
 *
 * Plain JavaScript on purpose. This exact file is what runs BOTH locally and
 * inside the Solari sandbox that hosts it for `--backend solari`. The base
 * sandbox image ships Node 18 and has no build step, so anything TypeScript
 * here would have to be compiled or duplicated -- and a second copy is how the
 * cloud quietly starts serving a different app than the one the local run
 * checked. One file, no translation.
 *
 * It reads a `tier` cookie and a `consent` cookie and renders different markup
 * for each combination, the same shape as a real product with a paywall and a
 * consent banner. Two combinations are deliberately WRONG, because a checker
 * that only ever sees correct pages proves nothing:
 *
 *   - `free` leaks the paid-only export button   (revenue leak)
 *   - consent=rejected still emits the tracker    (compliance breach)
 *
 * Both are switchable, so the same site demonstrates a failing run and a clean
 * one.
 */

/** @typedef {"anon" | "free" | "paid" | "admin"} Tier */
/** @typedef {{ leakExportToFree: boolean, trackerBeforeConsent: boolean }} Bugs */

/** @type {Bugs} */
export const DEFAULT_BUGS = { leakExportToFree: true, trackerBeforeConsent: true }

/** @type {Bugs} */
export const NO_BUGS = { leakExportToFree: false, trackerBeforeConsent: false }

/** @param {string} s */
const esc = (s) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])

/**
 * @param {Tier} tier
 * @param {string} consent
 * @param {Bugs} bugs
 * @returns {string}
 */
export function render(tier, consent, bugs) {
  const paid = tier === "paid" || tier === "admin"
  // The leak: `free` is not a paying tier, but the button renders anyway.
  const showExport = paid || (bugs.leakExportToFree && tier === "free")
  const showAdmin = tier === "admin"
  const consented = consent === "accepted"
  // The breach: the tracker should require consent, and does not.
  const tracker = consented || bugs.trackerBeforeConsent

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ledger — ${esc(tier)}</title>
${tracker ? `<script data-testid="tracker" src="/t.js"></script>` : ""}
</head><body>
<h1 data-testid="heading">Ledger</h1>
<p data-testid="tier">Signed in as: ${esc(tier)}</p>
${consented ? "" : `<div data-testid="consent-banner">We use cookies. <button>Accept</button></div>`}
${tier === "anon" ? `<a data-testid="signin" href="/signin">Sign in</a>` : ""}
${showExport ? `<button data-testid="export">Export all invoices (Pro)</button>` : ""}
${showAdmin ? `<a data-testid="admin" href="/admin">Admin console</a>` : ""}
<p data-testid="quota">Invoices this month: ${paid ? "unlimited" : "3 of 5"}</p>
</body></html>`
}

/** @param {string | undefined} header */
export function parseCookies(header) {
  return Object.fromEntries(
    String(header || "").split(";").map((p) => p.trim().split("=")).filter((p) => p.length === 2),
  )
}

/**
 * @param {Bugs} bugs
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void}
 */
export function makeHandler(bugs) {
  return (req, res) => {
    if (req.url === "/t.js") {
      res.writeHead(200, { "content-type": "application/javascript" })
      return res.end("//tracker\n")
    }
    if (req.url === "/favicon.ico") { res.writeHead(204); return res.end() }
    const c = parseCookies(req.headers.cookie)
    const tier = ["anon", "free", "paid", "admin"].includes(c.tier) ? c.tier : "anon"
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(render(/** @type {Tier} */ (tier), c.consent || "", bugs))
  }
}
