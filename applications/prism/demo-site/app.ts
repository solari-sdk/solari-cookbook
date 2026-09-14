/**
 * Typed surface over the demo app.
 *
 * The implementation lives in `site.js` because the Solari sandbox that hosts
 * this site for `--backend solari` runs Node 18 with no build step, and the
 * cloud must serve the same bytes the local run checked. This file exists only
 * so the TypeScript side gets real types.
 */
export type Tier = "anon" | "free" | "paid" | "admin"
export type Bugs = { leakExportToFree: boolean; trackerBeforeConsent: boolean }

export { DEFAULT_BUGS, NO_BUGS, render, makeHandler, parseCookies } from "./site.js"
