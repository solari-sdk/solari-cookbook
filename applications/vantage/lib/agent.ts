import {
  type HomepageScrape,
  scrapeHomepage,
  scrapePage,
  searchProductHunt,
  webSearch,
  withBrowser,
} from "./solari";
import { synthesizeTeardown } from "./llm";
import { buildUserPrompt, estimateTokens } from "./prompt";
import { describeLlmError, getProvider } from "./providers";
import { detectGithubOrg, fetchGithubRepos, searchHackerNews } from "./sources";
import type {
  EventSink,
  GithubBundle,
  LlmCredentials,
  HackerNewsBundle,
  ScrapeBundle,
  ScrapedPage,
  SearchBundle,
  SessionReplay,
  Teardown,
} from "./types";

/** Hard ceiling for a whole run, matching the product spec. */
export const RUN_TIMEOUT_MS = 90_000;

const PRICING_HINTS = ["/pricing", "/plans", "/price", "/pricing-plans"];
const ABOUT_HINTS = ["/about", "/about-us", "/company", "/team", "/our-story"];

export class DeadlineError extends Error {
  constructor(label: string) {
    super(`${label} exceeded the run deadline`);
    this.name = "DeadlineError";
  }
}

/** Accepts "acme.com", "acme.com/x", or a full URL. Throws on anything else. */
export function normalizeUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a competitor URL.");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" is not a valid URL.`);
  }
  if (!url.hostname.includes(".") || url.hostname.endsWith(".")) {
    throw new Error(`"${input}" is not a valid domain.`);
  }
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) {
    throw new Error("Local and private addresses are not supported.");
  }
  return url;
}

/**
 * Best-effort display name for the target.
 *
 * The brand can sit at either end of a page title — "Cal.com | Scheduling
 * Software" puts it first, "Agentic Infrastructure - Vercel" puts it last — so
 * taking the first segment is wrong half the time. Worse, the wrong name
 * propagates into every search query, and the whole report ends up about a
 * different company. So: pick the segment that corresponds to the domain, and
 * fall back to the domain itself rather than to a tagline.
 */
export function deriveCompany(host: string, title?: string): string {
  const labels = host
    .replace(/^www\./, "")
    .split(".")
    .slice(0, -1) // drop the TLD
    .filter(Boolean);
  const root = labels[labels.length - 1] ?? host;
  const pretty = root.charAt(0).toUpperCase() + root.slice(1);
  if (!title) return pretty;

  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Split on separators, but not on hyphens inside words ("self-driving").
  const segments = title
    .split(/\s*[|–—·]\s*|\s+[-:]\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 2 && segment.length <= 40);

  for (const segment of segments) {
    const flat = normalise(segment);
    if (!flat) continue;
    if (
      labels.some(
        (label) => flat.includes(normalise(label)) || normalise(label).includes(flat),
      )
    ) {
      return segment;
    }
  }

  return pretty;
}

function pickLink(links: string[], hints: string[]): string | null {
  for (const hint of hints) {
    const match = links.find((l) => {
      try {
        return new URL(l).pathname.toLowerCase().replace(/\/$/, "") === hint;
      } catch {
        return false;
      }
    });
    if (match) return match;
  }
  for (const hint of hints) {
    const match = links.find((l) => l.toLowerCase().includes(hint));
    if (match) return match;
  }
  return null;
}

function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Browse the competitor and the public web around them.
 *
 * Side-effect free apart from the injected `emit` sink: everything it learns is
 * returned in the bundle, and every source failure is recorded rather than
 * thrown, so one dead page never kills the run.
 */
export async function scrapeCompetitor(
  input: string,
  emit: EventSink,
  budgetMs: number,
  onReplay?: (replay: SessionReplay | null) => void,
): Promise<ScrapeBundle> {
  const url = normalizeUrl(input);
  const startedAt = Date.now();
  const remaining = () => budgetMs - (Date.now() - startedAt);

  emit("info", "target", `Resolved target → ${url.origin}`);
  emit("info", "session", "Requesting a Solari browser session…");

  const bundle = await withBrowser(async (context) => {
    emit("ok", "session", "Browser session live (recording on).");

    emit("info", "scrape", `Loading homepage ${url.origin}`);
    // Bounded, but the rejection is *caught* rather than allowed to propagate.
    // Letting it unwind would reach withBrowser's `finally`, closing the
    // browser out from under any in-flight page and surfacing a useless
    // "Browser closed" error; swallowing it here keeps the session alive so
    // the search, Hacker News, and GitHub phases still run.
    const home = await withDeadline(
      scrapeHomepage(context, url.toString()),
      Math.max(10_000, Math.min(30_000, remaining())),
      "homepage load",
    ).catch(
      (err: unknown): HomepageScrape => ({
        page: {
          label: "homepage",
          url: url.toString(),
          ok: false,
          error: err instanceof DeadlineError ? "timed out" : String(err),
        },
        techSignals: [],
        links: [],
        externalLinks: [],
        html: "",
        githubOrg: null,
      }),
    );

    if (!home.page.ok) {
      // Losing the homepage costs us the link graph and the fingerprints, but
      // search, Hacker News, and GitHub are all still reachable — a partial
      // teardown beats no teardown.
      emit(
        "warn",
        "scrape",
        `Homepage unavailable (${home.page.error}) — continuing on off-site sources only.`,
      );
    }

    const company = deriveCompany(url.hostname, home.page.title);
    if (home.page.ok) {
      emit("ok", "scrape", `Homepage read — "${home.page.title ?? url.hostname}"`);
    }
    emit("ok", "identify", `Reading this as: ${company}`);
    emit(
      home.techSignals.length > 0 ? "ok" : "warn",
      "fingerprint",
      home.techSignals.length > 0
        ? `${home.techSignals.length} stack signals: ${home.techSignals
            .slice(0, 6)
            .map((s) => s.name)
            .join(", ")}${home.techSignals.length > 6 ? "…" : ""}`
        : "No recognisable stack signals in page assets.",
    );

    const pricingUrl =
      pickLink(home.links, PRICING_HINTS) ?? new URL("/pricing", url.origin).toString();
    const aboutUrl =
      pickLink(home.links, ABOUT_HINTS) ?? new URL("/about", url.origin).toString();

    emit("info", "scrape", `Fetching pricing + about pages in parallel`);
    const [pricing, about] = await withDeadline(
      Promise.all([
        scrapePage(context, "pricing", pricingUrl),
        scrapePage(context, "about", aboutUrl),
      ]),
      Math.min(20_000, remaining()),
      "secondary pages",
    ).catch((err: unknown): [ScrapedPage, ScrapedPage] => {
      emit("warn", "scrape", `Secondary pages timed out: ${String(err)}`);
      return [
        { label: "pricing", url: pricingUrl, ok: false, error: "timed out" },
        { label: "about", url: aboutUrl, ok: false, error: "timed out" },
      ];
    });

    for (const page of [pricing, about]) {
      emit(
        page.ok ? "ok" : "warn",
        "scrape",
        page.ok
          ? `${page.label} page captured (${page.text?.length ?? 0} chars)`
          : `${page.label} page unavailable — ${page.error}`,
      );
    }

    // Terms a result must mention to count. Bing in particular will answer a
    // blocked query with a generic SERP; without this the report would be
    // grounded in results about a different company entirely.
    const subjectTerms = Array.from(
      new Set([
        url.hostname.replace(/^www\./, "").toLowerCase(),
        company.toLowerCase(),
        url.hostname.replace(/^www\./, "").split(".")[0].toLowerCase(),
      ]),
    );

    const queries = [
      `${company} reviews`,
      `${company} funding`,
      `${company} news`,
    ];
    emit("info", "search", `Searching the open web: ${queries.join(" · ")}`);

    // Hacker News and GitHub answer over plain HTTPS, so they run alongside
    // the browser work and stay available even when every engine blocks us.
    const githubOrg =
      home.githubOrg ?? detectGithubOrg(home.externalLinks, home.html);
    const offSiteWork = Promise.all([
      searchHackerNews(url.hostname, company),
      githubOrg
        ? fetchGithubRepos(githubOrg)
        : Promise.resolve<GithubBundle>({
            org: null,
            ok: false,
            repos: [],
            error: "no github.com link found on the site",
          }),
    ]);

    const searchWork = Promise.all([
      ...queries.map((q) => webSearch(context, q, { subjectTerms })),
      searchProductHunt(context, company, subjectTerms),
    ]);

    const searchResults = await withDeadline(
      searchWork,
      Math.max(5_000, Math.min(25_000, remaining())),
      "web search",
    ).catch((err: unknown) => {
      emit("warn", "search", `Search phase cut short: ${String(err)}`);
      return null;
    });

    const searches: SearchBundle[] = [];
    let productHunt: SearchBundle = {
      query: `site:producthunt.com ${company}`,
      ok: false,
      results: [],
      error: "not reached",
    };

    if (searchResults) {
      const [reviews, funding, news, ph] = searchResults;
      searches.push(reviews, funding, news);
      productHunt = ph;
      for (const s of searches) {
        emit(
          s.ok ? "ok" : "warn",
          "search",
          s.ok
            ? `"${s.query}" → ${s.results.length} results`
            : `"${s.query}" → blocked or empty (${s.error})`,
        );
      }
      emit(
        productHunt.ok ? "ok" : "warn",
        "producthunt",
        productHunt.ok
          ? `ProductHunt → ${productHunt.results.length} mentions`
          : `No ProductHunt trail found (${productHunt.error})`,
      );
    } else {
      for (const q of queries) {
        searches.push({ query: q, ok: false, results: [], error: "timed out" });
      }
    }

    const [hackerNews, github] = await withDeadline(
      offSiteWork,
      Math.max(3_000, Math.min(12_000, remaining())),
      "off-site sources",
    ).catch((): [HackerNewsBundle, GithubBundle] => [
      { query: url.hostname, ok: false, hits: [], error: "timed out" },
      { org: githubOrg, ok: false, repos: [], error: "timed out" },
    ]);

    emit(
      hackerNews.ok && hackerNews.hits.length > 0 ? "ok" : "warn",
      "hackernews",
      hackerNews.hits.length > 0
        ? `Hacker News → ${hackerNews.hits.length} stories, top: "${hackerNews.hits[0].title.slice(0, 60)}"`
        : `No Hacker News trail (${hackerNews.error ?? "no matching stories"})`,
    );
    emit(
      github.ok ? "ok" : "warn",
      "github",
      github.ok
        ? `GitHub @${github.org} → ${github.repos.length} active repos, ${github.repos[0]?.stars ?? 0}★ top`
        : `No GitHub org resolved (${github.error})`,
    );

    const result: ScrapeBundle = {
      target: {
        inputUrl: input,
        origin: url.origin,
        host: url.hostname,
        company,
      },
      pages: [home.page, pricing, about],
      techSignals: home.techSignals,
      searches,
      productHunt,
      hackerNews,
      github,
      startedAt,
      finishedAt: Date.now(),
    };
    return result;
  }, onReplay);

  emit(
    "ok",
    "scrape",
    `Collection done in ${((bundle.finishedAt - bundle.startedAt) / 1000).toFixed(1)}s.`,
  );
  return bundle;
}

/** Full run: browse, then synthesise. The only thing the API route calls. */
export async function runTeardown(
  input: string,
  credentials: LlmCredentials,
  emit: EventSink,
  signal: AbortSignal,
  onReplay?: (replay: SessionReplay | null) => void,
): Promise<Teardown> {
  const provider = getProvider(credentials.provider);
  if (!provider) throw new Error(`Unknown provider "${credentials.provider}".`);
  const model = credentials.model?.trim() || provider.defaultModel;

  const startedAt = Date.now();
  const remaining = () => RUN_TIMEOUT_MS - (Date.now() - startedAt);

  const bundle = await scrapeCompetitor(
    input,
    emit,
    Math.floor(RUN_TIMEOUT_MS * 0.6),
    (replay) => {
      emit(
        replay ? "ok" : "warn",
        "replay",
        replay
          ? "Session replay captured."
          : "No session replay available for this run.",
      );
      onReplay?.(replay);
    },
  );

  if (signal.aborted) throw new DeadlineError("run");

  const dossierTokens = estimateTokens(buildUserPrompt(bundle));
  emit(
    "info",
    "synthesize",
    `Dossier is ~${dossierTokens.toLocaleString()} tokens — sending to ${provider.label} (${model})…`,
  );
  const report = await withDeadline(
    synthesizeTeardown(bundle, { ...credentials, model }, signal),
    Math.max(5_000, remaining()),
    "synthesis",
  ).catch((err: unknown) => {
    // Never let a provider SDK error surface a stack trace containing the
    // request body — reduce it to something actionable first.
    throw err instanceof DeadlineError
      ? err
      : new Error(describeLlmError(err, provider.label));
  });

  emit(
    "ok",
    "synthesize",
    `Teardown ready — confidence: ${report.confidence}, ${report.opportunities.items.length} opportunities identified.`,
  );
  return report;
}
