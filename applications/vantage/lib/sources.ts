import type { GithubBundle, GithubRepo, HackerNewsBundle, HackerNewsHit } from "./types";

/**
 * Sources that answer over plain HTTPS. No browser, no bot wall, no captcha —
 * so these stay reliable even when every search engine blocks the session.
 * Both are called server-side with a short timeout and never throw.
 */

const FETCH_TIMEOUT_MS = 8_000;

async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "competitive-intelligence-agent",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface AlgoliaResponse {
  nbHits: number;
  hits: Array<{
    objectID: string;
    title: string | null;
    url: string | null;
    points: number | null;
    num_comments: number | null;
    created_at: string | null;
  }>;
}

/**
 * Hacker News via the public Algolia index. High-signal for launches, funding,
 * pivots, and the community's actual gripes — all dated, which is exactly what
 * the "recent moves" section needs.
 */
export async function searchHackerNews(
  host: string,
  company?: string,
): Promise<HackerNewsBundle> {
  const bareHost = host.replace(/^www\./, "");
  // Search the brand, not the domain: HN titles say "PostHog", not
  // "posthog.com", and querying the domain finds almost nothing.
  const brand = bareHost.split(".")[0];
  const query = (company?.trim() || brand).toLowerCase();
  const needles = Array.from(
    new Set([query, brand.toLowerCase(), bareHost.toLowerCase()]),
  ).filter((n) => n.length >= 3);
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`;

  try {
    const data = await getJson<AlgoliaResponse>(url);
    const hits: HackerNewsHit[] = data.hits
      .filter((hit) => hit.title)
      .map((hit) => ({
        title: hit.title as string,
        url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
        discussionUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        points: hit.points ?? 0,
        comments: hit.num_comments ?? 0,
        date: (hit.created_at ?? "").slice(0, 10),
      }))
      // Keep only stories that actually name the target.
      .filter((hit) => {
        const haystack = `${hit.title} ${hit.url}`.toLowerCase();
        return needles.some((needle) => haystack.includes(needle));
      })
      .sort((a, b) => b.points - a.points)
      .slice(0, 6);

    return { query, ok: true, hits };
  } catch (err) {
    return {
      query,
      ok: false,
      hits: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const GITHUB_RESERVED = new Set([
  "orgs", "topics", "features", "about", "pricing", "login", "signup",
  "explore", "marketplace", "sponsors", "apps", "settings", "search",
  "collections", "trending", "readme", "site", "enterprise", "security",
]);

/**
 * Find a github.com org/user handle. Anchors first; if the site renders its
 * footer client-side or links out through a router (PostHog and Cal.com both
 * do), fall back to scanning the raw HTML — the handle is almost always in
 * there as a meta tag, a JSON blob, or an inline script.
 */
export function detectGithubOrg(links: string[], html?: string): string | null {
  for (const link of links) {
    try {
      const url = new URL(link);
      if (!url.hostname.endsWith("github.com")) continue;
      const handle = url.pathname.split("/").filter(Boolean)[0];
      if (handle && !GITHUB_RESERVED.has(handle.toLowerCase())) return handle;
    } catch {
      // Not a URL — skip.
    }
  }

  if (!html) return null;

  // Count handles and take the most frequent — one-off links to unrelated
  // repos should not outvote the company's own org.
  const counts = new Map<string, number>();
  const pattern = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})/g;
  for (const match of html.matchAll(pattern)) {
    const handle = match[1];
    if (GITHUB_RESERVED.has(handle.toLowerCase())) continue;
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
}

interface GithubRepoResponse {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  pushed_at: string | null;
  archived: boolean;
}

/**
 * The org's most recently pushed public repos. Doubles as a tech-stack signal
 * (languages) and a momentum signal (what they last shipped to).
 */
export async function fetchGithubRepos(org: string): Promise<GithubBundle> {
  const endpoints = [
    `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?sort=pushed&per_page=8`,
    `https://api.github.com/users/${encodeURIComponent(org)}/repos?sort=pushed&per_page=8`,
  ];

  let lastError = "not attempted";
  for (const endpoint of endpoints) {
    try {
      const data = await getJson<GithubRepoResponse[]>(endpoint);
      const repos: GithubRepo[] = data
        .filter((repo) => !repo.archived)
        .map((repo) => ({
          name: repo.full_name,
          url: repo.html_url,
          description: repo.description ?? "",
          stars: repo.stargazers_count,
          language: repo.language ?? "",
          lastPush: (repo.pushed_at ?? "").slice(0, 10),
        }))
        .sort((a, b) => b.stars - a.stars)
        .slice(0, 5);

      if (repos.length > 0) return { org, ok: true, repos };
      lastError = "no public repositories";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { org, ok: false, repos: [], error: lastError };
}
