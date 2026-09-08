import { createRng, type Rng } from "./random.js"

/**
 * A perturbation is a change to the *environment*, never to the task.
 *
 * The task is fixed: add the headphones, apply the coupon, fill in the checkout
 * form, stop before paying. What moves is the world it happens in — a banner
 * over the button, a slow endpoint, a phone-sized viewport. Reliability is the
 * gap between the agent that can do the task once and the agent that can do it
 * when the world is not exactly as it was on the day it was written.
 *
 * Each perturbation reaches the run through one of two channels, and which one
 * is not a detail — it is the reason a cloud browser is involved at all:
 *
 *   site    the benchmark server renders differently for this run. Sent ahead
 *           of the browser, keyed by run id.
 *   browser the browser context is built differently, or its traffic is
 *           intercepted. Real Solari surface: contexts, viewports, locales,
 *           route interception.
 *
 * Every perturbation is a pure function of a seed. Nothing here calls
 * `Math.random` or reads the clock, so re-running a suite reproduces the same
 * environments and a difference between two runs is attributable to the agent.
 */
type PerturbationCategory = "none" | "ui" | "network" | "viewport" | "locale" | "state"

/** How the benchmark site renders for one run. Mirrored by fixture/shop.py. */
export interface SiteConfig {
  cookieBanner?: boolean
  unexpectedModal?: { afterMs: number }
  apiLatencyMs?: number
  delayedElement?: { delayMs: number }
  expiredSession?: { afterStage: "cart" | "checkout" }
  locale?: "de-DE"
}

/** How the browser context is built, and what happens to its traffic. */
export interface BrowserConfig {
  viewport?: { width: number; height: number }
  isMobile?: boolean
  hasTouch?: boolean
  deviceScaleFactor?: number
  userAgent?: string
  locale?: string
  networkDelay?: { pattern: string; delayMs: number }
}

export interface Perturbation {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly category: PerturbationCategory
  /** Omitted when this perturbation does not use the channel. */
  site?(rng: Rng): SiteConfig
  browser?(rng: Rng): BrowserConfig
}

export const PERTURBATIONS: readonly Perturbation[] = [
  {
    id: "baseline",
    name: "Baseline",
    description: "The shop exactly as it ships. This is the control.",
    category: "none",
  },

  {
    id: "cookie_banner",
    name: "Cookie banner",
    description: "A consent banner covers the primary button until it is dismissed.",
    category: "ui",
    // The banner genuinely intercepts the click server-side as well as visually,
    // so an agent cannot pass by ignoring it and hoping the coordinates land.
    site: () => ({ cookieBanner: true }),
  },

  {
    id: "unexpected_modal",
    name: "Unexpected modal",
    description: "A newsletter interstitial appears shortly after a page loads and blocks clicks.",
    category: "ui",
    // Jittered from the seed so the modal lands at a different point in the
    // agent's loop on each repetition. A fixed delay is an obstacle; a moving
    // one is a reliability test.
    site: (rng) => ({ unexpectedModal: { afterMs: rng.jitter(1_200, 0.4) } }),
  },

  {
    id: "slow_api",
    name: "Slow API",
    description: "State-changing requests take noticeably longer, but still succeed.",
    category: "network",
    site: (rng) => ({ apiLatencyMs: rng.jitter(1_500, 0.3) }),
  },

  {
    id: "delayed_element",
    name: "Delayed element",
    description: "The add-to-cart control hydrates late, well inside the task's time budget.",
    category: "ui",
    site: (rng) => ({ delayedElement: { delayMs: rng.jitter(1_800, 0.3) } }),
  },

  {
    id: "expired_session",
    name: "Expired session",
    description: "The session expires partway through. The cart survives and can be resumed.",
    category: "state",
    // Alternating the trigger stage by seed means a suite exercises both the
    // early and the late failure instead of only ever the same one.
    site: (rng) => ({ expiredSession: { afterStage: rng.bool() ? "cart" : "checkout" } }),
  },

  {
    id: "mobile_viewport",
    name: "Mobile viewport",
    description: "A phone-sized viewport with touch input, so the layout stacks and controls move.",
    category: "viewport",
    // Solari has no session-level viewport option — `launch()` takes stealth,
    // proxy and profile, not screen size. Anything about the shape of the
    // window has to be a browser *context* option, which is why this channel
    // exists at all. The shop ships a real `max-width:480px` stylesheet, so this
    // is a different layout and not merely a smaller window.
    browser: () => ({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    }),
  },

  {
    id: "network_delay",
    name: "Network delay",
    description: "Every response is delayed in the browser, the way a bad connection would.",
    category: "network",
    // Applied with route interception rather than by slowing the server: this
    // delays *assets* too, so late layout and late hydration get exercised in a
    // way a server-side sleep on the API cannot reproduce.
    browser: (rng) => ({ networkDelay: { pattern: "**/*", delayMs: rng.jitter(350, 0.4) } }),
  },

  {
    id: "locale_variant",
    name: "German locale",
    description: "The storefront renders in German. The task and its verdict are unchanged.",
    category: "locale",
    // Both channels, and deliberately so: a real locale change moves the
    // browser's Accept-Language and Intl behaviour as well as the server's
    // copy. Changing only one produces a page no real visitor ever sees.
    site: () => ({ locale: "de-DE" }),
    browser: () => ({ locale: "de-DE" }),
  },
]

const BY_ID = new Map(PERTURBATIONS.map((p) => [p.id, p]))

export function requirePerturbation(id: string): Perturbation {
  const found = BY_ID.get(id)
  if (!found) {
    throw new Error(
      `unknown variant "${id}". Known variants: ${PERTURBATIONS.map((p) => p.id).join(", ")}`,
    )
  }
  return found
}

export interface ResolvedEnvironment {
  site: SiteConfig
  browser: BrowserConfig
}

/**
 * The single place a seed turns into a concrete environment.
 *
 * Both channels are resolved from one `Rng`, so the site configuration and the
 * browser configuration for a given trial are always the same pair. Resolving
 * them separately would let the two halves of `locale_variant` disagree.
 */
export function resolveEnvironment(perturbation: Perturbation, seed: number): ResolvedEnvironment {
  const rng = createRng(seed)
  return {
    site: perturbation.site?.(rng) ?? {},
    browser: perturbation.browser?.(rng) ?? {},
  }
}
