import type { Finding } from "@/lib/types";
import { sameOrigin } from "@/lib/server/guards";
import { envInt } from "@/lib/server/env";
import { findingId } from "@/lib/server/finding-id";

// Page handle from Solari browser (Playwright-compatible)
export type BrowserPage = {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  context(): { cookies(url: string): Promise<{ name: string; secure: boolean; httpOnly: boolean }[]> };
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
};

const SECRET_PATTERNS: { re: RegExp; title: string; severity: Finding["severity"] }[] = [
  { re: /AKIA[0-9A-Z]{16}/, title: "Possible AWS access key in page", severity: "critical" },
  { re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, title: "Private key in page source", severity: "critical" },
  { re: /sk_live_[0-9a-zA-Z]{20,}/, title: "Possible Stripe live secret key", severity: "critical" },
  { re: /ghp_[0-9a-zA-Z]{30,}/, title: "Possible GitHub token in page", severity: "high" },
  { re: /api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}/i, title: "Hardcoded API key pattern", severity: "high" },
];

export interface CrawlResult {
  findings: Finding[];
  pagesVisited: string[];
}

async function checkPage(page: BrowserPage, url: string, isHttps: boolean): Promise<Finding[]> {
  const findings: Finding[] = [];

  const cookies = await page.context().cookies(url);
  for (const c of cookies) {
    if (isHttps && !c.secure) {
      findings.push({
        id: findingId("cookie", `${url}:insecure:${c.name}`),
        severity: "medium",
        category: "cookies",
        title: `Cookie "${c.name}" missing Secure flag`,
        detail: `Cookie set without Secure on HTTPS page`,
        url,
        remediation: "Set Secure on all cookies served over HTTPS",
        source: "crawl",
      });
    }
    if (!c.httpOnly && /session|auth|token|jwt/i.test(c.name)) {
      findings.push({
        id: findingId("cookie", `${url}:httponly:${c.name}`),
        severity: "medium",
        category: "cookies",
        title: `Session cookie "${c.name}" missing HttpOnly`,
        detail: "Auth-related cookie accessible to JavaScript",
        url,
        remediation: "Set HttpOnly on session and auth cookies",
        source: "crawl",
      });
    }
  }

  const mixed = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll("[src], [href]")) {
      const attr = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
      if (attr.startsWith("http://")) bad.push(attr);
    }
    return bad.slice(0, 5);
  });
  if (isHttps && mixed.length > 0) {
    findings.push({
      id: findingId("mixed", url),
      severity: "medium",
      category: "misconfig",
      title: "Mixed content detected",
      detail: `Found ${mixed.length} HTTP resource(s) on HTTPS page`,
      evidence: mixed.join("\n"),
      url,
      remediation: "Serve all assets over HTTPS",
      source: "crawl",
    });
  }

  const html = await page.content();
  for (const { re, title, severity } of SECRET_PATTERNS) {
    if (re.test(html)) {
      findings.push({
        id: findingId("secret", `${url}:${title}`),
        severity,
        category: "exposure",
        title,
        detail: "Pattern matched in page HTML or scripts",
        url,
        remediation: "Remove secrets from client-side code; rotate exposed credentials",
        source: "crawl",
      });
    }
  }

  const forms = await page.evaluate(() =>
    [...document.querySelectorAll("form")].map((f) => ({
      action: f.action,
      method: (f.method || "get").toLowerCase(),
      hasCsrf: !!f.querySelector('input[name*="csrf" i], input[name="_token"]'),
    })),
  );
  for (const form of forms) {
    if (form.method === "post" && !form.hasCsrf) {
      findings.push({
        id: findingId("form", `${url}:${form.action}:${form.method}`),
        severity: "low",
        category: "misconfig",
        title: "POST form without obvious CSRF token",
        detail: `Form posts to ${form.action}`,
        url,
        remediation: "Add CSRF protection to state-changing forms",
        source: "crawl",
      });
    }
  }

  return findings;
}

export async function crawlSite(
  page: BrowserPage,
  startUrl: string,
  origin: string,
): Promise<CrawlResult> {
  const maxPages = envInt("MAX_CRAWL_PAGES", 50);
  const visited = new Set<string>();
  const queue = [startUrl];
  const findings: Finding[] = [];
  const isHttps = startUrl.startsWith("https://");

  while (queue.length > 0 && visited.size < maxPages) {
    const url = queue.shift()!;
    if (visited.has(url) || !sameOrigin(url, origin)) continue;
    visited.add(url);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      findings.push(...(await checkPage(page, url, isHttps)));

      const links = await page.evaluate((origin) => {
        return [...document.querySelectorAll("a[href]")]
          .map((a) => {
            try {
              return new URL(a.getAttribute("href")!, window.location.href).href;
            } catch {
              return null;
            }
          })
          .filter((u): u is string => !!u && u.startsWith(origin));
      }, origin);

      for (const link of links) {
        if (!visited.has(link)) queue.push(link);
      }
    } catch {
      findings.push({
        id: findingId("nav", url),
        severity: "info",
        category: "misconfig",
        title: "Page failed to load during crawl",
        detail: "Navigation error or timeout",
        url,
        remediation: "Check page availability and error handling",
        source: "crawl",
      });
    }
  }

  return { findings, pagesVisited: [...visited] };
}
