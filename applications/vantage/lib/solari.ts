import { Solari, SolariError, type BrowserSession } from "@solarisdk/browser";
import type { BrowserContext, Page } from "patchright-core";
import type {
  ScrapedPage,
  SearchBundle,
  SearchResult,
  SessionReplay,
  TechSignal,
} from "./types";

/**
 * Max characters of page text handed to the model per page.
 *
 * Marketing pages front-load their substance: the positioning, the pricing
 * table, and the value props are all in the first couple of thousand
 * characters, and the rest is footer boilerplate. Trimming from 6k to 2.6k cut
 * the prompt by roughly half with no observed loss in report quality.
 */
const MAX_PAGE_TEXT = 2_600;
/** Per-navigation ceiling. Kept tight so the whole run stays under a minute. */
const NAV_TIMEOUT_MS = 15_000;

const BLOCKED_RESOURCES = new Set(["image", "media", "font"]);

/** github.com paths that are site chrome, not an org or user. */
const GITHUB_RESERVED_HANDLES = [
  "orgs", "topics", "features", "about", "pricing", "login", "signup",
  "explore", "marketplace", "sponsors", "apps", "settings", "search",
  "collections", "trending", "readme", "site", "enterprise", "security",
];

/**
 * Most marketing sites render their nav, footer, and third-party tags after
 * `domcontentloaded`. Reading the DOM at that point costs us the link graph and
 * most asset fingerprints, so give the page a bounded moment to settle. Both
 * waits are best-effort — a page that never goes idle still gets read.
 */
async function settle(page: Page, quietMs = 700): Promise<void> {
  await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(quietMs);
}

export function getSolari(): Solari {
  const apiKey = process.env.SOLARI_API_KEY;
  if (!apiKey || apiKey.startsWith("your_key")) {
    throw new Error(
      "SOLARI_API_KEY is missing or still a placeholder. Set it in .env.local.",
    );
  }
  return new Solari({ apiKey });
}

/** Solari needs a moment to finalise the recording after the session is released. */
const REPLAY_POLL_ATTEMPTS = 5;
const REPLAY_POLL_DELAY_MS = 900;

/**
 * Mint the presigned replay link. `BrowserSession.close()` already performs a
 * `releaseAndWait`, but the recording is only queryable ~1-3s after that, so
 * poll briefly rather than accepting the first 404.
 */
async function captureReplay(
  solari: Solari,
  sessionId: string,
): Promise<SessionReplay | null> {
  for (let attempt = 0; attempt < REPLAY_POLL_ATTEMPTS; attempt++) {
    try {
      const { url, expiresInSeconds } = await solari.sessions.getReplayUrl(sessionId);
      return { sessionId, url, expiresInSeconds, capturedAt: Date.now() };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, REPLAY_POLL_DELAY_MS));
    }
  }
  return null;
}

/**
 * Launch a recorded session, run `fn`, and always release the session —
 * including when `fn` throws or the caller's deadline fires.
 *
 * The replay link arrives through `onReplay` rather than the return value,
 * because it only exists after the session is released — which happens in the
 * `finally` block, after `fn`'s value has already been returned. Routing it
 * through a callback means a run that failed halfway still yields a replay,
 * which is exactly when you most want to watch what the agent saw.
 */
export async function withBrowser<T>(
  fn: (ctx: BrowserContext) => Promise<T>,
  onReplay?: (replay: SessionReplay | null) => void,
): Promise<T> {
  const solari = getSolari();
  let browser: BrowserSession | undefined;
  // Read the session id off the wrapper before close(); it is spent afterwards.
  let sessionId: string | undefined;

  try {
    // Stealth is what makes the search phase work at all: from a plain
    // datacenter egress every engine either blocks outright or (Bing) serves a
    // canned SERP that ignores the query. With stealth on, DuckDuckGo answers
    // normally. `recording` is what produces the replay. Both are plan
    // features, so both degrade together — fall back rather than fail.
    //
    // `retries` turns the post-connect probe on; its 2s default is too tight
    // for a cold session over the wire, so give it real headroom.
    const launchOptions = { retries: 1, probeTimeoutMs: 8_000, recording: true };
    try {
      browser = await solari.launch({ ...launchOptions, stealth: true });
    } catch (err) {
      if (err instanceof SolariError && err.code === "FeatureRequiresPlan") {
        browser = await solari.launch({ retries: 1, probeTimeoutMs: 8_000 });
      } else {
        throw err;
      }
    }
    sessionId = browser.id;

    const context = browser.contexts()[0] ?? (await browser.newContext());
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    // Drop bytes we never read. Roughly halves time-to-DOM on marketing sites.
    await context.route("**/*", (route) => {
      if (BLOCKED_RESOURCES.has(route.request().resourceType())) {
        return route.abort();
      }
      return route.continue();
    });

    return await fn(context);
  } finally {
    await browser?.close().catch(() => {});
    if (onReplay) {
      onReplay(
        sessionId ? await captureReplay(solari, sessionId).catch(() => null) : null,
      );
    }
    await solari.close().catch(() => {});
  }
}

export function describeSolariError(err: unknown): string {
  if (err instanceof SolariError) {
    return `Solari ${err.code ?? err.status ?? "error"}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function collapse(text: string, limit = MAX_PAGE_TEXT): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

async function readableText(page: Page): Promise<string> {
  const raw = await page.evaluate(() => {
    document
      .querySelectorAll("script, style, noscript, svg, iframe")
      .forEach((n) => n.remove());
    return document.body?.innerText ?? "";
  });
  return collapse(raw);
}

/** Navigate and extract title + visible text. Never throws — failures are data. */
export async function scrapePage(
  context: BrowserContext,
  label: string,
  url: string,
): Promise<ScrapedPage> {
  let page: Page | undefined;
  try {
    page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    const status = response?.status() ?? 0;
    if (status >= 400) {
      return { label, url, ok: false, error: `HTTP ${status}` };
    }
    await settle(page, 400);
    const [title, text] = await Promise.all([page.title(), readableText(page)]);
    return { label, url, ok: true, finalUrl: page.url(), title, text };
  } catch (err) {
    return { label, url, ok: false, error: describeSolariError(err) };
  } finally {
    await page?.close().catch(() => {});
  }
}

/** Front-end fingerprints, keyed by a lowercase needle found in page assets. */
const TECH_RULES: Array<[string, TechSignal["category"], string[]]> = [
  ["Next.js", "framework", ["__next_data__", "/_next/"]],
  ["Nuxt", "framework", ["__nuxt__", "/_nuxt/"]],
  ["Remix", "framework", ["__remixcontext"]],
  ["React", "framework", ["react-dom", "data-reactroot"]],
  ["Svelte / SvelteKit", "framework", ["svelte-", "/_app/immutable/"]],
  ["Webflow", "framework", ["webflow"]],
  ["Framer", "framework", ["framerusercontent"]],
  ["WordPress", "framework", ["wp-content", "wp-includes"]],
  ["Shopify", "framework", ["cdn.shopify.com"]],
  ["Vercel", "hosting", ["vercel.app", "vercel-insights", "vercel-analytics"]],
  ["Netlify", "hosting", ["netlify"]],
  ["Cloudflare", "hosting", ["cdn-cgi", "cloudflare"]],
  ["AWS CloudFront", "hosting", ["cloudfront.net"]],
  ["Google Analytics / GTM", "analytics", ["googletagmanager", "google-analytics"]],
  ["Segment", "analytics", ["cdn.segment", "analytics.js"]],
  ["PostHog", "analytics", ["posthog"]],
  ["Mixpanel", "analytics", ["mixpanel"]],
  ["Amplitude", "analytics", ["amplitude"]],
  ["Hotjar", "analytics", ["hotjar"]],
  ["Plausible", "analytics", ["plausible.io"]],
  ["Sentry", "analytics", ["sentry"]],
  ["Stripe", "payments", ["js.stripe.com", "stripe.com"]],
  ["Paddle", "payments", ["paddle.com"]],
  ["Chargebee", "payments", ["chargebee"]],
  ["Intercom", "support", ["intercom"]],
  ["Crisp", "support", ["crisp.chat"]],
  ["Zendesk", "support", ["zendesk", "zdassets"]],
  ["Drift", "support", ["drift.com"]],
  ["HubSpot", "marketing", ["hs-scripts", "hubspot"]],
  ["Marketo", "marketing", ["marketo"]],
  ["Customer.io", "marketing", ["customer.io"]],
  ["Auth0", "auth", ["auth0"]],
  ["Clerk", "auth", ["clerk.accounts", "clerk.com"]],
  ["Firebase", "auth", ["firebaseapp", "firebaseio"]],
  ["WorkOS", "auth", ["workos"]],
  ["Algolia", "other", ["algolia"]],
  ["Typeform", "other", ["typeform"]],
  ["Calendly", "other", ["calendly"]],
  ["Cal.com", "other", ["cal.com"]],
];

export interface HomepageScrape {
  page: ScrapedPage;
  techSignals: TechSignal[];
  /** Same-origin links harvested from the homepage, absolute and deduped. */
  links: string[];
  /** Off-site links (GitHub, social, docs) — where the GitHub org shows up. */
  externalLinks: string[];
  /** Truncated raw HTML, for signals that never become anchors. */
  html: string;
  /**
   * github.com handle found anywhere in the document. Detected in-page because
   * the handle often lives past the truncation point of a large document, and
   * frequently is not an anchor at all.
   */
  githubOrg: string | null;
}

/**
 * One navigation, three payloads: readable text, front-end fingerprints, and
 * the same-origin link graph used to locate /pricing and /about. Folding these
 * into a single page visit is the biggest single latency win in the run.
 */
export async function scrapeHomepage(
  context: BrowserContext,
  url: string,
): Promise<HomepageScrape> {
  const empty: HomepageScrape = {
    page: { label: "homepage", url, ok: false, error: "not attempted" },
    techSignals: [],
    links: [],
    externalLinks: [],
    html: "",
    githubOrg: null,
  };

  let page: Page | undefined;
  try {
    page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    const status = response?.status() ?? 0;
    if (status >= 400) {
      return { ...empty, page: { label: "homepage", url, ok: false, error: `HTTP ${status}` } };
    }

    await settle(page);
    const probe = await probeAssets(page);
    const githubOrg = await page.evaluate((reserved: string[]) => {
      const skip = new Set(reserved);
      const counts = new Map<string, number>();
      const pattern =
        /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})/g;
      for (const match of document.documentElement.outerHTML.matchAll(pattern)) {
        const handle = match[1];
        if (skip.has(handle.toLowerCase())) continue;
        counts.set(handle, (counts.get(handle) ?? 0) + 1);
      }
      let best: string | null = null;
      let bestCount = 0;
      for (const [handle, count] of counts) {
        if (count > bestCount) {
          best = handle;
          bestCount = count;
        }
      }
      return best;
    }, GITHUB_RESERVED_HANDLES);

    const { links, externalLinks } = await page.evaluate(() => {
      const origin = location.origin;
      const hrefs = Array.from(document.querySelectorAll("a[href]")).map(
        (a) => (a as HTMLAnchorElement).href,
      );
      const unique = Array.from(new Set(hrefs));
      return {
        links: unique.filter((h) => h.startsWith(origin)).slice(0, 300),
        externalLinks: unique
          .filter((h) => h.startsWith("http") && !h.startsWith(origin))
          .slice(0, 200),
      };
    });
    const [title, text] = await Promise.all([page.title(), readableText(page)]);

    return {
      page: { label: "homepage", url, ok: true, finalUrl: page.url(), title, text },
      techSignals: matchTechSignals(probe),
      links,
      externalLinks,
      html: probe.html,
      githubOrg,
    };
  } catch (err) {
    return {
      ...empty,
      page: { label: "homepage", url, ok: false, error: describeSolariError(err) },
    };
  } finally {
    await page?.close().catch(() => {});
  }
}

/**
 * Fingerprint the front-end from script/link/meta tags plus a few globals.
 * Cheap, deterministic, and far more reliable than asking Claude to guess.
 */
export async function detectTechSignals(
  context: BrowserContext,
  url: string,
): Promise<TechSignal[]> {
  let page: Page | undefined;
  try {
    page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return matchTechSignals(await probeAssets(page));
  } catch {
    return [];
  } finally {
    await page?.close().catch(() => {});
  }
}

interface AssetProbe {
  srcs: string[];
  links: string[];
  metas: string[];
  globals: string[];
  html: string;
}

async function probeAssets(page: Page): Promise<AssetProbe> {
  return page.evaluate(() => {
    const srcs = Array.from(document.querySelectorAll("script[src]")).map(
      (s) => (s as HTMLScriptElement).src,
    );
    const links = Array.from(document.querySelectorAll("link[href]")).map(
      (l) => (l as HTMLLinkElement).href,
    );
    const metas = Array.from(
      document.querySelectorAll("meta[name][content]"),
    ).map((m) => `${m.getAttribute("name")}=${m.getAttribute("content")}`);
    const w = window as unknown as Record<string, unknown>;
    const globals = [
      "__NEXT_DATA__",
      "__NUXT__",
      "__remixContext",
      "Shopify",
      "Intercom",
      "analytics",
      "dataLayer",
      "Stripe",
      "posthog",
      "Sentry",
    ].filter((k) => k in w);
    return {
      srcs,
      links,
      metas,
      globals,
      html: document.documentElement.outerHTML.slice(0, 40_000),
    };
  });
}

function matchTechSignals(probe: AssetProbe): TechSignal[] {
  const haystack = [
    ...probe.srcs,
    ...probe.links,
    ...probe.metas,
    ...probe.globals,
    probe.html,
  ]
    .join("\n")
    .toLowerCase();

  const signals: TechSignal[] = [];
  for (const [name, category, needles] of TECH_RULES) {
    const hit = needles.find((n) => haystack.includes(n));
    if (hit && !signals.some((s) => s.name === name)) {
      signals.push({
        name,
        category,
        evidence: `matched "${hit}" in page assets`,
      });
    }
  }
  return signals;
}

/**
 * Engines are tried in order; the first that yields a usable result set wins.
 *
 * The ordering is measured, not preference. From a Solari session the results
 * were: DuckDuckGo's HTML endpoint answers correctly with stealth on (and
 * serves a captcha without it); Google returns an "unusual traffic"
 * interstitial either way; Bing returns HTTP 200 with ten results but serves
 * the *same* canned SERP for every query, which is why `isRelevant` below
 * exists — a silently wrong result set is worse than a blocked one.
 */
const SEARCH_ENGINES = [
  {
    name: "duckduckgo",
    url: (q: string) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    // Answers the query it was given, so "no relevant hits" from it is a real
    // answer and the ladder can stop there.
    trusted: true,
  },
  {
    name: "google",
    url: (q: string) =>
      `https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&hl=en`,
    trusted: true,
  },
  {
    name: "bing",
    url: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    // Serves an identical canned SERP for every query when it decides we are a
    // bot, so an irrelevant result set from Bing proves nothing.
    trusted: false,
  },
] as const;

/** Search pages should answer fast; a slow one is a block, not a slow page. */
const SEARCH_NAV_TIMEOUT_MS = 8_000;

/** Runs in the page. Handles Google, Bing, and DuckDuckGo result markup. */
function extractResults(max: number): Array<{
  title: string;
  url: string;
  snippet: string;
}> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];

  // Bing wraps every href in a /ck/a redirect carrying the real URL as a
  // base64url `u` param prefixed with "a1". Google uses /url?q=.
  const resolve = (href: string): string => {
    try {
      const u = new URL(href, location.href);
      if (u.hostname.endsWith("bing.com") && u.pathname.startsWith("/ck/")) {
        const raw = u.searchParams.get("u");
        if (!raw) return href;
        let b = (raw.startsWith("a1") ? raw.slice(2) : raw)
          .replace(/-/g, "+")
          .replace(/_/g, "/");
        while (b.length % 4 !== 0) b += "=";
        const decoded = atob(b);
        return decoded.startsWith("http") ? decoded : href;
      }
      if (u.pathname === "/url") return u.searchParams.get("q") ?? href;
      return u.href;
    } catch {
      return href;
    }
  };

  const push = (title: string, href: string, snippet: string) => {
    if (out.length >= max) return;
    const url = resolve(href);
    const t = title.replace(/\s+/g, " ").trim();
    const s = snippet.replace(/\s+/g, " ").trim().slice(0, 180);
    if (!t || !url.startsWith("http")) return;
    if (out.some((r) => r.url === url)) return;
    out.push({ title: t, url, snippet: s });
  };

  // Bing.
  document.querySelectorAll("li.b_algo").forEach((el) => {
    const a = el.querySelector("h2 a") as HTMLAnchorElement | null;
    const snippet = el.querySelector(".b_caption p, [class*='lineclamp']");
    if (!a) return;
    push(
      el.querySelector("h2")?.textContent ?? "",
      a.getAttribute("href") ?? "",
      snippet?.textContent ?? "",
    );
  });

  // Google organic results.
  document.querySelectorAll("div.g, div[data-sokoban-container]").forEach((el) => {
    const a = el.querySelector("a[href]") as HTMLAnchorElement | null;
    const h = el.querySelector("h3");
    if (!a || !h) return;
    push(h.textContent ?? "", a.getAttribute("href") ?? "", el.textContent ?? "");
  });

  // DuckDuckGo HTML endpoint.
  document.querySelectorAll("div.result, div.web-result").forEach((el) => {
    const a = el.querySelector("a.result__a") as HTMLAnchorElement | null;
    if (!a) return;
    push(
      a.textContent ?? "",
      a.getAttribute("href") ?? "",
      el.querySelector(".result__snippet")?.textContent ?? "",
    );
  });

  return out.slice(0, max);
}

export interface SearchOptions {
  limit?: number;
  /**
   * Terms the target is known by. A result must mention at least one of them
   * in its title, snippet, or URL to be kept — this is what discards an engine
   * that answered with a generic SERP instead of the actual query.
   */
  subjectTerms?: string[];
}

function isRelevant(result: SearchResult, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack =
    `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

export async function webSearch(
  context: BrowserContext,
  query: string,
  options: SearchOptions = {},
): Promise<SearchBundle & { engine: string }> {
  const limit = options.limit ?? 5;
  const terms = (options.subjectTerms ?? [])
    .map((t) => t.toLowerCase().trim())
    .filter(Boolean);

  let lastError = "no results";

  for (const engine of SEARCH_ENGINES) {
    let page: Page | undefined;
    try {
      page = await context.newPage();
      await page.goto(engine.url(query), {
        waitUntil: "domcontentloaded",
        timeout: SEARCH_NAV_TIMEOUT_MS,
      });
      const raw: SearchResult[] = await page.evaluate(extractResults, limit * 2);

      if (raw.length === 0) {
        lastError = `${engine.name} returned nothing parseable (consent wall or bot check)`;
        continue;
      }

      const results = raw.filter((r) => isRelevant(r, terms)).slice(0, limit);
      if (results.length > 0) {
        return { query, ok: true, results, engine: engine.name };
      }

      // A trusted engine that answered with nothing on-topic has genuinely
      // found nothing. Walking the rest of the ladder for it just burns time
      // on engines that will block us anyway.
      if (engine.trusted) {
        return {
          query,
          ok: false,
          results: [],
          error: `no results about the target (via ${engine.name})`,
          engine: engine.name,
        };
      }
      lastError = `${engine.name} answered with ${raw.length} results, none about the target — treating as a bot-blocked SERP`;
    } catch (err) {
      lastError = `${engine.name}: ${describeSolariError(err)}`;
    } finally {
      await page?.close().catch(() => {});
    }
  }

  return { query, ok: false, results: [], error: lastError, engine: "none" };
}

/**
 * ProductHunt itself is JS-heavy and rate-limits hard, so find its pages
 * through search. The `site:` operator is unreliable across these engines, so
 * search plainly and filter by host here.
 */
export async function searchProductHunt(
  context: BrowserContext,
  company: string,
  subjectTerms: string[],
): Promise<SearchBundle> {
  const query = `site:producthunt.com ${company}`;
  const bundle = await webSearch(context, query, {
    limit: 12,
    subjectTerms,
  });
  const results = bundle.results.filter((r) => {
    try {
      return new URL(r.url).hostname.endsWith("producthunt.com");
    } catch {
      return false;
    }
  });

  if (results.length === 0) {
    return {
      query,
      ok: false,
      results: [],
      error: bundle.ok ? "no ProductHunt pages in the result set" : bundle.error,
    };
  }
  return { query, ok: true, results: results.slice(0, 4) };
}
