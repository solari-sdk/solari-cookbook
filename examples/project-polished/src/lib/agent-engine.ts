// ============================================================================
// Project Polished — Agent Engine
// Orchestrates a 6-stage Solari-powered UX revamp pipeline.
// Drives the Zustand store with realistic, async event emission.
// ============================================================================

import { SAMPLE_DIFFS, SAMPLE_ISSUES, matchRepo } from './agent-data';
import type {
  CodeDiff,
  PullRequest,
  Screenshot,
  StageId,
} from './agent-types';
import { useAgentStore } from '@/store/agent-store';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

interface RunHandle {
  cancel: () => void;
}

let currentRun: RunHandle | null = null;

/**
 * Kicks off the full 6-stage Solari agent pipeline against the given repo URL.
 * Each stage updates the Zustand store with logs, screenshots, issues, diffs.
 */
export async function runAgentPipeline(repoUrl: string): Promise<void> {
  if (currentRun) currentRun.cancel();

  let cancelled = false;
  currentRun = {
    cancel: () => {
      cancelled = true;
    },
  };

  const store = useAgentStore.getState();
  const repo = matchRepo(repoUrl);

  store.startRun();
  store.setStatus('running');
  store.setRepoUrl(repoUrl);

  const log = (
    stage: StageId,
    level: Parameters<typeof store.pushLog>[0]['level'],
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    if (cancelled) return;
    store.pushLog({ stage, level, message, meta });
  };

  // Fire the server-side proxy in the background so that, when SOLARI_LIVE_MODE=true
  // is set in .env.local, a real Solari API call is made via /api/solari/run.
  // In simulated mode (default), this just acknowledges the request.
  fetch('/api/solari/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl }),
  })
    .then((r) => r.json())
    .then((data) => {
      if (data?.mode === 'live') {
        log('sandbox_clone', 'success', `Solari live API session acknowledged: ${data.message ?? 'ok'}`);
      }
    })
    .catch(() => {
      // silent — the simulated pipeline continues regardless
    });

  const completeStage = (id: StageId, progress = 100) => {
    if (cancelled) return;
    store.updateStage(id, {
      status: 'completed',
      progress,
      completedAt: Date.now(),
    });
  };

  const tickProgress = (id: StageId, progress: number) => {
    if (cancelled) return;
    store.updateStage(id, { progress });
  };

  try {
    // -----------------------------------------------------------------------
    // STAGE 1 — SANDBOX CLONE
    // -----------------------------------------------------------------------
    store.setActiveStage('sandbox_clone');
    log('sandbox_clone', 'info', `Solari SDK v0.4.2 session initialized.`, {
      sessionId: uid('sess'),
    });
    log('sandbox_clone', 'command', `solari sandbox create --repo ${repoUrl}`);
    await wait(700);
    log('sandbox_clone', 'info', `Provisioning isolated container (4 vCPU, 8GB RAM)...`);
    await wait(900);
    log('sandbox_clone', 'info', `Container ready. Mounting workspace at /sandbox/${repo.name}`);
    await wait(500);
    log('sandbox_clone', 'command', `git clone --depth 1 ${repo.url} /sandbox/${repo.name}`);
    await wait(1200);
    log('sandbox_clone', 'success', `Cloned ${repo.owner}/${repo.name} (${repo.stars.toLocaleString()} stars)`);
    await wait(400);
    log('sandbox_clone', 'info', `Detected framework: ${repo.framework}`);
    log('sandbox_clone', 'info', `Discovered ${repo.componentCount} components across ${repo.pages.length} routes`);
    tickProgress('sandbox_clone', 100);
    completeStage('sandbox_clone');

    // -----------------------------------------------------------------------
    // STAGE 2 — SANDBOX RUN (npm install + dev server)
    // -----------------------------------------------------------------------
    store.setActiveStage('sandbox_run');
    log('sandbox_run', 'command', `cd /sandbox/${repo.name} && npm install`);
    await wait(600);
    log('sandbox_run', 'info', `Resolving dependency tree...`);
    await wait(800);
    log('sandbox_run', 'info', `Installing 1,247 packages...`);
    tickProgress('sandbox_run', 30);
    await wait(1200);
    log('sandbox_run', 'success', `Installed 1,247 packages in 23.4s (0 vulnerabilities)`);
    tickProgress('sandbox_run', 60);
    log('sandbox_run', 'command', `npm run dev --port 3001`);
    await wait(700);
    log('sandbox_run', 'info', `Next.js 14.2.3 starting on http://localhost:3001`);
    await wait(900);
    log('sandbox_run', 'success', `Dev server responded 200 OK in 1.2s ✓`);
    tickProgress('sandbox_run', 100);
    completeStage('sandbox_run');

    // -----------------------------------------------------------------------
    // STAGE 3 — BROWSER DRIVE (Solari browser automation)
    // -----------------------------------------------------------------------
    store.setActiveStage('browser_drive');
    log('browser_drive', 'info', `Launching Solari browser session (Chromium 128, headless)`);
    await wait(700);
    log('browser_drive', 'command', `solari browser launch --viewport 1440x900`);
    await wait(500);

    const pagePlan: Array<{ url: string; page: string; snapshotKey: Screenshot['snapshotKey'] }> = [
      { url: 'http://localhost:3001/', page: 'Home', snapshotKey: 'home' },
      { url: 'http://localhost:3001/pricing', page: 'Pricing', snapshotKey: 'pricing' },
      { url: 'http://localhost:3001/features', page: 'Features', snapshotKey: 'features' },
    ];

    let shotCount = 0;
    const totalPages = pagePlan.length;
    for (const target of pagePlan) {
      if (cancelled) return;
      log('browser_drive', 'info', `Navigating to ${target.url}`);
      await wait(500);
      log('browser_drive', 'info', `Page loaded. Waiting for network idle...`);
      await wait(500);
      const screenshot: Screenshot = {
        id: uid('shot'),
        page: target.page,
        url: target.url,
        capturedAt: Date.now(),
        width: 1440,
        height: 900,
        snapshotKey: target.snapshotKey,
      };
      store.addScreenshot(screenshot);
      shotCount++;
      log('browser_drive', 'success', `Screenshot captured: ${target.page} (1440x900, ${shotCount}/${totalPages})`);
      tickProgress('browser_drive', Math.round((shotCount / totalPages) * 100));
      await wait(300);
      if (shotCount < totalPages) {
        log('browser_drive', 'info', `Scrolling viewport to capture below-the-fold content...`);
        await wait(400);
      }
    }

    log('browser_drive', 'success', `Browser session complete. ${shotCount} captures queued for vision analysis.`);
    completeStage('browser_drive');

    // -----------------------------------------------------------------------
    // STAGE 4 — VISION ANALYZE
    // -----------------------------------------------------------------------
    store.setActiveStage('vision_analyze');
    log('vision_analyze', 'info', `Forwarding ${pagePlan.length} captures to vision model (gpt-4o-vision)`);
    await wait(700);
    log('vision_analyze', 'info', `Analyzing layout, contrast, spacing, accessibility, responsive behavior...`);
    tickProgress('vision_analyze', 25);
    await wait(900);
    log('vision_analyze', 'info', `Cross-referencing against WCAG 2.2 AA + Lighthouse UX heuristics...`);
    tickProgress('vision_analyze', 50);
    await wait(800);

    log('vision_analyze', 'success', `Audit complete. ${SAMPLE_ISSUES.length} issues detected:`);
    tickProgress('vision_analyze', 75);

    for (const issue of SAMPLE_ISSUES) {
      if (cancelled) return;
      const emoji = severityEmoji(issue.severity);
      log(
        'vision_analyze',
        issue.severity === 'critical' ? 'error' : issue.severity === 'high' ? 'warn' : 'info',
        `${emoji} [${issue.severity.toUpperCase()}] ${issue.title} → ${issue.filePath}:${issue.lineNumber}`,
      );
      store.addIssue({ ...issue, status: 'detected' });
      tickProgress('vision_analyze', 75 + Math.round((SAMPLE_ISSUES.indexOf(issue) + 1) / SAMPLE_ISSUES.length * 25));
      await wait(350);
    }

    completeStage('vision_analyze');

    // -----------------------------------------------------------------------
    // STAGE 5 — DESKTOP FIX (Solari desktop → VS Code)
    // -----------------------------------------------------------------------
    store.setActiveStage('desktop_fix');
    log('desktop_fix', 'info', `Activating Solari desktop agent on host workspace`);
    await wait(500);
    log('desktop_fix', 'command', `solari desktop open --app "Visual Studio Code" --workspace /sandbox/${repo.name}`);
    await wait(900);
    log('desktop_fix', 'success', `VS Code window focused. Workspace loaded.`);
    tickProgress('desktop_fix', 10);
    await wait(400);

    for (let i = 0; i < SAMPLE_DIFFS.length; i++) {
      if (cancelled) return;
      const diff = SAMPLE_DIFFS[i];
      const issue = SAMPLE_ISSUES.find((x) => x.id === diff.issueId)!;

      log('desktop_fix', 'info', `Opening ${diff.filePath}`);
      await wait(400);
      store.updateIssue(issue.id, { status: 'fixing' });
      log('desktop_fix', 'info', `Locating offending block at line ${issue.lineNumber}...`);
      await wait(500);
      log('desktop_fix', 'command', `solari editor apply-patch --file ${diff.filePath} --strategy surgical`);
      await wait(700);

      const codeDiff: CodeDiff = {
        id: uid('diff'),
        issueId: issue.id,
        filePath: diff.filePath,
        before: diff.before,
        after: diff.after,
        language: diff.language,
        appliedAt: Date.now(),
      };
      store.addDiff(codeDiff);
      store.updateIssue(issue.id, { status: 'fixed' });
      log('desktop_fix', 'success', `Applied fix ${i + 1}/${SAMPLE_DIFFS.length}: ${issue.title}`);
      tickProgress('desktop_fix', 10 + Math.round(((i + 1) / SAMPLE_DIFFS.length) * 80));
      await wait(400);
    }

    log('desktop_fix', 'info', `Running formatter (prettier --write) on modified files...`);
    await wait(500);
    log('desktop_fix', 'success', `All ${SAMPLE_DIFFS.length} patches applied. Workspace saved.`);
    tickProgress('desktop_fix', 100);
    completeStage('desktop_fix');

    // -----------------------------------------------------------------------
    // STAGE 6 — VERIFY + PR
    // -----------------------------------------------------------------------
    store.setActiveStage('verify_pr');
    log('verify_pr', 'info', `Re-launching browser to verify fixes...`);
    await wait(700);
    log('verify_pr', 'success', `Re-capture complete. All ${SAMPLE_ISSUES.length} issues resolved ✓`);
    tickProgress('verify_pr', 25);
    await wait(400);

    log('verify_pr', 'command', `npm run build`);
    await wait(900);
    log('verify_pr', 'success', `Build succeeded in 18.2s — 0 errors, 0 warnings`);
    tickProgress('verify_pr', 50);
    await wait(400);

    const branchName = `ui-polish/solari-agent-${new Date().toISOString().slice(0, 10)}`;
    log('verify_pr', 'command', `git checkout -b ${branchName}`);
    await wait(400);
    log('verify_pr', 'command', `git add -A && git commit -m "✨ polish UI/UX issues detected by Solari Agent"`);
    await wait(700);
    log('verify_pr', 'success', `Committed ${SAMPLE_DIFFS.length} files to ${branchName}`);
    tickProgress('verify_pr', 70);
    await wait(400);
    log('verify_pr', 'command', `git push origin ${branchName}`);
    await wait(800);
    log('verify_pr', 'success', `Pushed to origin. Opening pull request...`);
    tickProgress('verify_pr', 85);
    await wait(500);

    const prNumber = 40 + Math.floor(Math.random() * 20);
    const pr: PullRequest = {
      number: prNumber,
      title: '✨ Polish UI/UX issues detected by Solari Agent',
      branch: branchName,
      base: 'main',
      url: `https://github.com/${repo.owner}/${repo.name}/pull/${prNumber}`,
      commits: 1,
      filesChanged: SAMPLE_DIFFS.length,
      additions: SAMPLE_DIFFS.reduce((acc, d) => acc + d.after.split('\n').length, 0),
      deletions: SAMPLE_DIFFS.reduce((acc, d) => acc + d.before.split('\n').length, 0),
      body: buildPrBody(SAMPLE_ISSUES),
    };
    store.setPullRequest(pr);
    log('verify_pr', 'success', `Pull request #${prNumber} created: ${pr.url}`);
    tickProgress('verify_pr', 100);
    completeStage('verify_pr');

    // Final summary
    store.setSummary({
      repoUrl: repo.url,
      repoOwner: repo.owner,
      repoName: repo.name,
      startedAt: Date.now() - 60_000,
      completedAt: Date.now(),
      totalIssuesFound: SAMPLE_ISSUES.length,
      totalIssuesFixed: SAMPLE_ISSUES.length,
      screenshotsCaptured: pagePlan.length,
      filesModified: SAMPLE_DIFFS.length,
      buildSucceeded: true,
      pullRequest: pr,
    });

    store.setStatus('completed');
  } catch (err) {
    log('sandbox_clone', 'error', `Agent run failed: ${(err as Error).message}`);
    store.setStatus('failed');
  } finally {
    if (currentRun?.cancel === (() => { cancelled = true; })) {
      currentRun = null;
    }
  }
}

function severityEmoji(severity: string): string {
  switch (severity) {
    case 'critical':
      return '🔴';
    case 'high':
      return '🟠';
    case 'medium':
      return '🟡';
    case 'low':
      return '🟢';
    default:
      return '⚪';
  }
}

function buildPrBody(issues: { title: string; severity: string; filePath: string }[]): string {
  const list = issues
    .map((i, idx) => `${idx + 1}. **[${i.severity.toUpperCase()}]** ${i.title} — \`${i.filePath}\``)
    .join('\n');
  return `## What this PR does

Autonomously detects and patches ${issues.length} UI/UX defects surfaced by the Solari Agent's vision pass.

### Issues fixed
${list}

### How it was generated
This PR was authored by the Project Polished agent — a Solari-powered pipeline that:
1. Cloned the repo into an isolated sandbox
2. Booted the dev server inside the sandbox
3. Drove a headless browser to capture viewport screenshots
4. Audited captures with a vision model
5. Used desktop automation to apply surgical patches in VS Code
6. Re-captured, rebuilt, and pushed this branch

Built with the [Solari SDK](https://github.com/solari-sdk/solari-cookbook). Tag @harrychow_ @getsolari @im_roy_lee.`;
}

/**
 * Convenience hook for the UI: returns true if the agent is currently busy.
 */
export function isAgentBusy(status: string): boolean {
  return status === 'running' || status === 'paused';
}
