import type { ScanEvent, StoredScan, Finding } from "@/lib/types";
import { validateTargetUrl, sameOrigin } from "./guards";
import { isDomainVerified } from "./verify";
import { countScansToday, saveScan } from "./db";
import { createSandbox, exec, killSandbox } from "./solari-sandbox";
import { createBrowser, closeBrowser, type BrowserSession } from "./solari-browser";
import { runPassiveScans } from "./scanners/passive";
import { runNucleiScan } from "./scanners/nuclei";
import { crawlSite } from "./scanners/crawl";
import { runAgent } from "./openrouter";

export async function runScan(
  scanId: string,
  rawUrl: string,
  emit: (event: ScanEvent) => void,
): Promise<StoredScan> {
  const startedAt = Date.now();

  emit({ type: "status", step: "validate", message: "Validating target URL" });
  const target = await validateTargetUrl(rawUrl);

  const verified = await isDomainVerified(target.hostname, target.origin);
  if (!verified) {
    throw new Error(
      `Domain not verified. Add DNS TXT or meta tag — see /verify?host=${target.hostname}`,
    );
  }

  try {
    const count = await countScansToday(target.hostname);
    if (count >= 5) throw new Error("Daily scan limit reached for this domain (5/day)");
  } catch (e) {
    if (e instanceof Error && e.message.includes("DATABASE_URL")) {
      // DB optional during dev without postgres
    } else if (e instanceof Error && e.message.includes("Daily scan")) {
      throw e;
    }
  }

  emit({ type: "status", step: "passive", message: "Running passive checks" });
  const sandboxId = await createSandbox();
  emit({ type: "log", message: `sandbox ready (${sandboxId.slice(-12)})` });

  let browserSession: BrowserSession | null = null;
  let browserPage: Awaited<ReturnType<BrowserSession["browser"]["newPage"]>> | null = null;
  let replayUrl: string | null = null;
  const rawFindings: Finding[] = [];
  let pagesVisited: string[] = [];

  try {
    const execFn = (cmd: string, args: string[]) => exec(sandboxId, cmd, args);

    const [passive, nuclei] = await Promise.all([
      runPassiveScans(sandboxId, target.url.href, execFn),
      runNucleiScan(target.url.href, execFn),
    ]);
    rawFindings.push(...passive, ...nuclei);
    for (const f of rawFindings) emit({ type: "finding", finding: f });

    emit({ type: "status", step: "crawl", message: "Crawling site in cloud browser" });
    browserSession = await createBrowser();
    browserPage = await browserSession.browser.newPage();
    const crawl = await crawlSite(browserPage, target.url.href, target.origin);
    pagesVisited = crawl.pagesVisited;
    rawFindings.push(...crawl.findings);
    for (const f of crawl.findings) emit({ type: "finding", finding: f });
    emit({ type: "log", message: `crawled ${pagesVisited.length} page(s)` });

    emit({ type: "status", step: "collect", message: "Collecting findings" });

    emit({ type: "status", step: "agent", message: "AI security review" });
    const report = await runAgent({
      targetUrl: target.url.href,
      rawFindings,
      pagesVisited,
      onReasoning: (delta) => emit({ type: "reasoning", delta }),
      onTool: (name, detail, done) => emit({ type: "tool", name, detail, done }),
      executeTool: async (name, args) => {
        if (name === "run_command") {
          const out = await exec(
            sandboxId,
            String(args.cmd ?? ""),
            Array.isArray(args.args) ? args.args.map(String) : [],
          );
          return `exit ${out.exitCode}\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`;
        }
        if (!browserSession || !browserPage) return "error: browser not available";
        const pg = browserPage;
        if (name === "browser_navigate") {
          const url = String(args.url ?? "");
          if (!sameOrigin(url, target.origin)) return "error: URL outside scan scope";
          await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          return `navigated to ${pg.url()}`;
        }
        if (name === "browser_read_page") {
          const title = await pg.title();
          const text = await pg.evaluate(() => document.body?.innerText?.slice(0, 8000) ?? "");
          return JSON.stringify({ url: pg.url(), title, text });
        }
        if (name === "browser_evaluate") {
          const result = await pg.evaluate(String(args.expression ?? "null"));
          return JSON.stringify(result);
        }
        return `error: unknown tool "${name}"`;
      },
    });

    replayUrl = await closeBrowser(browserSession);
    browserSession = null;

    const stored: StoredScan = {
      id: scanId,
      url: target.url.href,
      hostname: target.hostname,
      verdict: report.verdict,
      confidence: Math.max(0, Math.min(100, Math.round(report.confidence))),
      summary: report.summary,
      priorityFixes: report.priorityFixes,
      findings: report.findings,
      replayUrl,
      durationMs: Date.now() - startedAt,
      createdAt: new Date().toISOString(),
    };

    try {
      await saveScan(stored);
    } catch {
      emit({ type: "log", message: "warning: could not persist scan (database unavailable)" });
    }

    emit({ type: "status", step: "done" });
    emit({ type: "done", scanId, payload: stored });
    return stored;
  } finally {
    if (browserSession) {
      try {
        await closeBrowser(browserSession);
      } catch {
        // best effort
      }
    }
    await killSandbox(sandboxId);
    emit({ type: "log", message: "sandbox destroyed" });
  }
}
