import { safeText, probeDigest, type Manifest } from './domain.ts';
import type { Receipt, LaneReceipt } from './runner.ts';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clean(text: string, secrets: string[]): string {
  return esc(safeText(text, secrets));
}

function verdictStyle(v: string): { color: string; label: string } {
  switch (v) {
    case 'verified': return { color: '#16a34a', label: 'VERIFIED' };
    case 'not_reproduced': return { color: '#d97706', label: 'NOT REPRODUCED' };
    case 'still_failing': return { color: '#dc2626', label: 'STILL FAILING' };
    default: return { color: '#6b7280', label: 'INCONCLUSIVE' };
  }
}

function outputBlock(o: { exitCode: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; durationMs: number }, secrets: string[]): string {
  return `<dl>
        <dt>Exit code</dt><dd>${o.exitCode}</dd>
        <dt>Timed out</dt><dd>${o.timedOut}</dd>
        <dt>Truncated</dt><dd>${o.truncated}</dd>
        <dt>Duration</dt><dd>${o.durationMs}ms</dd>
      </dl>
      <pre class="out">${clean(o.stdout, secrets)}${o.stderr ? '\n--- stderr ---\n' + clean(o.stderr, secrets) : ''}</pre>`;
}

function laneHtml(lane: LaneReceipt, _manifest: Manifest, secrets: string[]): string {
  const title = lane.lane === 'baseline' ? 'Baseline' : 'Candidate';
  const stateClass = lane.state === 'released' ? 'ok' : 'err';
  let html = `<section class="lane"><h3>${title}</h3>
    <dl>
      <dt>State</dt><dd class="${stateClass}">${clean(lane.state, secrets)}</dd>
      <dt>Session</dt><dd>${clean(lane.sessionId ?? 'none', secrets)}</dd>
      <dt>Duration</dt><dd>${lane.durationMs}ms</dd>`;
  if (lane.error) html += `\n      <dt>Error</dt><dd class="err">${clean(lane.error, secrets)}</dd>`;
  if (lane.cleanupError) html += `\n      <dt>Cleanup error</dt><dd class="err">${clean(lane.cleanupError, secrets)}</dd>`;
  html += `\n    </dl>`;
  if (lane.result) {
    html += `\n    <dl><dt>Observed probe SHA-256</dt><dd><code>${clean(lane.result.probeSha256 ?? 'not recorded', secrets)}</code></dd></dl>`;
    if (lane.result.setup.length > 0) {
      html += `\n    <h4>Setup</h4>`;
      lane.result.setup.forEach((s, i) => { html += `\n    <div class="cmd"><h5>Step ${i + 1}</h5>${outputBlock(s, secrets)}</div>`; });
    }
    if (lane.result.probe) {
      html += `\n    <h4>Probe output</h4>\n    ${outputBlock(lane.result.probe, secrets)}`;
    } else {
      html += `\n    <p>Probe did not execute.</p>`;
    }
    html += `\n    <h4>Runtime</h4><dl><dt>Python</dt><dd>${clean(lane.result.runtime.python, secrets)}</dd><dt>Platform</dt><dd>${clean(lane.result.runtime.platform, secrets)}</dd></dl>`;
  } else {
    html += `\n    <p>No guest result.</p>`;
  }
  html += `\n  </section>`;
  return html;
}

export function generateReport(receipt: Receipt, secrets: string[] = []): string {
  const m = receipt.manifest;
  const v = verdictStyle(receipt.verdict);
  const providerBg = receipt.provider === 'solari' ? '#dbeafe' : '#fef3c7';
  const providerFg = receipt.provider === 'solari' ? '#1e40af' : '#92400e';
  const providerLabel = receipt.provider === 'solari' ? 'SOLARI' : 'LOCAL SIMULATION';
  const allReleased = receipt.lanes.every(l => l.state === 'released');
  const cleanupSummary = allReleased ? '&#10003; All resources confirmed released' : '&#9888; ' + clean(receipt.lanes.map(l => `${l.lane}: ${l.state}`).join(', '), secrets);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PatchProof: ${clean(m.name, secrets)} &#8212; ${v.label}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;line-height:1.6;max-width:900px;margin:0 auto;padding:2rem;background:#fafafa;color:#1a1a1a}
h1{font-size:1.5rem;margin-bottom:.5rem}
h2{font-size:1.2rem;margin:1.5rem 0 .5rem;border-bottom:1px solid #e5e5e5;padding-bottom:.25rem}
h3{font-size:1.1rem;margin:.75rem 0 .5rem}
h4{font-size:.95rem;margin:.75rem 0 .25rem;color:#555}
h5{font-size:.85rem;color:#666;margin:.25rem 0}
dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem 1rem;margin:.5rem 0;font-size:.9rem}
dt{font-weight:600;color:#555}
dd{word-break:break-all}
.verdict{display:inline-block;padding:.4rem 1.2rem;border-radius:.4rem;font-size:1.4rem;font-weight:700;color:#fff;background:${v.color}}
.provider{display:inline-block;padding:.2rem .6rem;border-radius:.25rem;font-size:.8rem;font-weight:600;background:${providerBg};color:${providerFg};margin-left:.5rem;vertical-align:middle}
.ok{color:#16a34a}
.err{color:#dc2626}
.lane{background:#fff;border:1px solid #e5e5e5;border-radius:.5rem;padding:1rem;margin:.5rem 0}
.out{background:#111;color:#e5e5e5;padding:.75rem;border-radius:.375rem;overflow-x:auto;font-size:.8rem;max-height:20rem;white-space:pre-wrap;word-break:break-all}
.cmd{margin:.5rem 0;padding:.5rem;background:#f5f5f5;border-radius:.25rem}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:.5rem;padding:1rem;margin:.5rem 0}
code{font-size:.85rem;background:#f0f0f0;padding:.1rem .25rem;border-radius:.25rem}
details summary{cursor:pointer;font-size:.9rem}
footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #e5e5e5;font-size:.75rem;color:#888}
</style>
</head>
<body>
<h1>PatchProof Report</h1>
<div class="verdict">${v.label}</div>
<span class="provider">${providerLabel}</span>

<h2>Experiment</h2>
<div class="card">
<dl>
  <dt>Name</dt><dd>${clean(m.name, secrets)}</dd>
  <dt>Run ID</dt><dd><code>${clean(receipt.id, secrets)}</code></dd>
  <dt>Started</dt><dd>${clean(receipt.startedAt, secrets)}</dd>
  <dt>Ended</dt><dd>${clean(receipt.endedAt, secrets)}</dd>
  <dt>Source</dt><dd>${m.source.kind === 'git' ? clean(m.source.url, secrets) : 'fixture'}</dd>${m.source.kind === 'git' ? `
  <dt>Baseline revision</dt><dd><code>${clean(m.source.baseline, secrets)}</code></dd>
  <dt>Candidate revision</dt><dd><code>${clean(m.source.candidate, secrets)}</code></dd>` : ''}
</dl>
</div>

<h2>Probe</h2>
<div class="card">
<dl>
  <dt>Command</dt><dd><code>${clean(m.probe.argv.join(' '), secrets)}</code></dd>
  <dt>Expected failure</dt><dd>exit ${m.probe.expectedFailure.exitCode}, contains <code>${clean(m.probe.expectedFailure.contains, secrets)}</code></dd>
  <dt>Expected success</dt><dd>contains <code>${clean(m.probe.expectedSuccess.contains, secrets)}</code></dd>
  <dt>Expected probe SHA-256</dt><dd><code>${probeDigest(m.probe)}</code></dd>
</dl>${Object.keys(m.probe.files).length > 0 ? `
<h4>Probe files</h4>
${Object.entries(m.probe.files).map(([name, content]) => `<details><summary><code>${clean(name, secrets)}</code></summary><pre class="out">${clean(content, secrets)}</pre></details>`).join('\n')}` : ''}
</div>

<h2>Lanes</h2>
${receipt.lanes.map(l => laneHtml(l, m, secrets)).join('\n')}

<h2>Evidence &amp; Integrity</h2>
<div class="card">
<dl>
  <dt>Sessions created</dt><dd>${receipt.cost.sessionsCreated}</dd>
  <dt>Compute</dt><dd>${receipt.cost.computeSeconds.toFixed(1)}s</dd>${receipt.provider === 'solari' ? `
  <dt>Estimated cost</dt><dd>$${receipt.cost.estimatedUsd.toFixed(4)} (at $${receipt.cost.rateUsdPerHour}/hr, estimate only)</dd>` : ''}
  <dt>Manifest SHA-256</dt><dd><code>${clean(receipt.manifestSha256, secrets)}</code></dd>
  <dt>Receipt SHA-256</dt><dd><code>${clean(receipt.sha256, secrets)}</code></dd>
  <dt>Cleanup</dt><dd>${cleanupSummary}</dd>
</dl>
</div>

<footer>
PatchProof v0.1.0. ${receipt.provider === 'simulation' ? '<strong>LOCAL SIMULATION &#8212; reviewed fixtures ran on this computer without remote isolation; not real Solari evidence.</strong>' : 'Evidence from Solari sandboxes.'}
Report text is escaped and sanitized; it does not authenticate guest claims.
</footer>
</body>
</html>`;
}
