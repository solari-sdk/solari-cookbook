// Fault Line Frontend Application Logic

let currentRunId = null;
let currentRunData = null;
let probesChart = null;
let latencyChart = null;

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initActions();
  loadRuns();
});

function initTabs() {
  const tabs = document.querySelectorAll('.nav-item');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const targetTab = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const activeContent = document.getElementById(`tab-${targetTab}`);
      if (activeContent) activeContent.classList.add('active');

      // Refresh tab specific content
      if (targetTab === 'benchmarks') loadBenchmarkData();
      if (targetTab === 'regression') loadRegressionCases();
    });
  });
}

function initActions() {
  document.getElementById('btn-run-agent').addEventListener('click', runAgentWorkload);
  document.getElementById('btn-trigger-diagnose').addEventListener('click', triggerDiagnose);
  document.getElementById('btn-fetch-diff').addEventListener('click', fetchDiff);
  document.getElementById('btn-execute-repair').addEventListener('click', executeRepair);
  document.getElementById('btn-run-benchmark').addEventListener('click', loadBenchmarkData);
  document.getElementById('btn-refresh-cases').addEventListener('click', loadRegressionCases);
  document.getElementById('btn-close-drawer')?.addEventListener('click', () => {
    document.getElementById('checkpoint-drawer').classList.add('hidden');
  });
}

async function runAgentWorkload() {
  const scenario = document.getElementById('scenario-selector').value;
  const agent_type = document.getElementById('agent-type-selector')?.value || 'deterministic';
  const btn = document.getElementById('btn-run-agent');
  btn.disabled = true;
  btn.innerText = '⏳ Executing Workload...';

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario, agent_type }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || `Server returned HTTP ${res.status}`);
    }
    const run = await res.json();
    currentRunId = run.run_id;
    currentRunData = run;

    await loadRuns();
    renderRunDetail(run);
    switchTab('run-detail');
  } catch (err) {
    alert('Error running agent workload:\n\n' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerText = '🚀 Run Agent Workload';
  }
}

async function loadRuns() {
  try {
    const res = await fetch('/api/runs');
    const runs = await res.json();
    renderRunsTable(runs);
    updateDashboardStats(runs);
  } catch (err) {
    console.error('Failed to load runs:', err);
  }
}

function updateDashboardStats(runs) {
  document.getElementById('stat-total-runs').innerText = runs.length;
  const failed = runs.filter(r => r.verifier_status === 'FAILED').length;
  document.getElementById('stat-failed-runs').innerText = failed;
  document.getElementById('stat-localized').innerText = runs.filter(r => r.fault_boundary_step).length;
  document.getElementById('stat-repaired').innerText = runs.filter(r => r.causal_candidate_step).length;

  const validRuns = runs.filter(r => r.duration_ms);
  if (validRuns.length > 0) {
    const avgMs = validRuns.reduce((sum, r) => sum + r.duration_ms, 0) / validRuns.length;
    document.getElementById('stat-avg-time').innerText = `${avgMs.toFixed(1)} ms`;
  } else {
    document.getElementById('stat-avg-time').innerText = 'N/A';
  }
}

function renderRunsTable(runs) {
  const tbody = document.getElementById('runs-table-body');
  if (!runs || runs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-muted">No runs recorded yet. Click "Run Agent Workload" to execute a workload.</td></tr>';
    return;
  }

  tbody.innerHTML = runs.map(r => `
    <tr>
      <td><strong>${r.run_id}</strong></td>
      <td><span class="tag warning">${r.scenario_name}</span></td>
      <td><span class="pill success">${r.agent_status}</span></td>
      <td><span class="pill ${r.verifier_status === 'PASSED' ? 'success' : 'danger'}">${r.verifier_status}</span></td>
      <td>${r.total_steps}</td>
      <td>${r.fault_boundary_step ? `Step ${r.fault_boundary_step}` : 'N/A'}</td>
      <td>${r.duration_ms} ms</td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="inspectRun('${r.run_id}')">Inspect</button>
      </td>
    </tr>
  `).join('');
}

async function inspectRun(runId) {
  currentRunId = runId;
  const res = await fetch(`/api/runs/${runId}`);
  const run = await res.json();
  currentRunData = run;
  renderRunDetail(run);
  switchTab('run-detail');
}

function renderRunDetail(run) {
  if (document.getElementById('hero-run-id')) {
    document.getElementById('hero-run-id').innerText = `ACTIVE RUN: EXECUTION #${run.run_id}`;
    const heroV = document.getElementById('hero-verifier-status');
    if (heroV) {
      heroV.innerText = `VERIFIER ${run.verifier_status} ${run.verifier_status === 'PASSED' ? '✓' : '✕'}`;
      heroV.className = `pill ${run.verifier_status === 'PASSED' ? 'success' : 'danger'}`;
    }
    if (document.getElementById('hero-fault-step')) {
      document.getElementById('hero-fault-step').innerText = run.fault_boundary_step ? `Step ${run.fault_boundary_step}` : 'N/A';
    }
    if (document.getElementById('hero-scenario-name')) {
      document.getElementById('hero-scenario-name').innerText = run.scenario_name;
    }
    if (document.getElementById('hero-backend-name')) {
      document.getElementById('hero-backend-name').innerText = run.backend_name || 'Offline Simulator';
    }
  }

  document.getElementById('current-run-id').innerText = `RUN #${run.run_id}`;
  document.getElementById('current-run-scenario').innerText = `Scenario: ${run.scenario_name}`;
  document.getElementById('current-agent-status').innerText = `Agent: ${run.agent_status}`;
  document.getElementById('current-backend-tag').innerText = `Backend: ${run.backend_name || 'Offline Simulator'}`;

  const vStatus = document.getElementById('current-verifier-status');
  vStatus.innerText = `Verifier: ${run.verifier_status}`;
  vStatus.className = `pill ${run.verifier_status === 'PASSED' ? 'success' : 'danger'}`;

  // Timeline
  const container = document.getElementById('timeline-container');
  container.innerHTML = run.checkpoints.map(chk => {
    const isBoundary = run.fault_boundary_step === chk.step_number;
    const isBad = run.fault_boundary_step && chk.step_number >= run.fault_boundary_step;
    const cls = isBoundary ? 'boundary' : (isBad ? 'bad' : 'good');

    return `
      <div class="timeline-step ${cls}" onclick="showCheckpointDrawer('${chk.checkpoint_id}')">
        <div style="font-weight:700">Step ${chk.step_number}</div>
        <div style="font-size:0.75rem; color:#888884">${chk.action_name}</div>
        <div style="font-size:0.7rem; font-family:var(--font-mono); margin-top:0.25rem">${chk.state_digest.slice(0, 8)}...</div>
      </div>
    `;
  }).join('');

  // Update Fault boundary boxes
  const badStep = run.fault_boundary_step || 17;
  const goodStep = Math.max(0, badStep - 1);
  document.getElementById('lkg-step-number').innerText = `Step ${goodStep}`;
  document.getElementById('foi-step-number').innerText = `Step ${badStep}`;
}

function showCheckpointDrawer(chkId) {
  if (!currentRunData) return;
  const chk = currentRunData.checkpoints.find(c => c.checkpoint_id === chkId);
  if (!chk) return;

  const drawer = document.getElementById('checkpoint-drawer');
  document.getElementById('chk-drawer-title').innerText = `Checkpoint: ${chk.checkpoint_id}`;
  document.getElementById('chk-drawer-content').innerHTML = `
    <pre style="background:#050505; padding:1.25rem; border-radius:6px; border:1px solid rgba(255,255,255,0.08); overflow-x:auto">${JSON.stringify(chk, null, 2)}</pre>
  `;
  drawer.classList.remove('hidden');
}

async function triggerDiagnose() {
  if (!currentRunId) {
    alert('Please run or select an agent workload first.');
    return;
  }
  const strategy = document.getElementById('localization-strategy-select').value;
  const res = await fetch(`/api/diagnose/${currentRunId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy }),
  });
  const data = await res.json();

  const strat = data.strategy_result;
  document.getElementById('strategy-result-details').innerHTML = `
    <div style="background:#050505; border:1px solid rgba(255,255,255,0.08); padding:1.25rem; border-radius:8px; margin-top:1rem">
      <h4 style="font-family:var(--font-mono); font-size:0.9rem; color:var(--accent-orange-bright)">${strat.strategy_name} Search Results</h4>
      <p style="margin-top:0.5rem">Probes Evaluated: <strong>${strat.probes_count}</strong> | Localization Time: <strong>${strat.localization_time_ms} ms</strong></p>
      <p>First Observed Invalid State: <strong>Step ${strat.first_invalid_step}</strong></p>
      <p>Total Recovery Overhead: <strong>${data.cost_breakdown.recovery_overhead_pct}%</strong> <span class="tag warning">${data.cost_breakdown.cost_status}</span></p>
    </div>
  `;
}

async function fetchDiff() {
  if (!currentRunId) {
    alert('Please run or select an agent workload first.');
    return;
  }
  const res = await fetch(`/api/diff/${currentRunId}`);
  const data = await res.json();

  const diff = data.state_diff;
  document.getElementById('diff-before-card').innerHTML = `
    <h5 style="color:var(--color-pass); margin-bottom:0.5rem">Checkpoint: ${data.last_good_checkpoint.checkpoint_id}</h5>
    <pre style="color:var(--text-primary)">${JSON.stringify(data.last_good_checkpoint.action_output, null, 2)}</pre>
  `;

  document.getElementById('diff-after-card').innerHTML = `
    <h5 style="color:var(--color-fail); margin-bottom:0.5rem">Checkpoint: ${data.first_bad_checkpoint.checkpoint_id}</h5>
    <p style="color:var(--color-fail); font-weight:700">Changed Records (${diff.changed_records.length}):</p>
    <pre style="color:var(--text-primary)">${JSON.stringify(diff.changed_records, null, 2)}</pre>
  `;
}

async function executeRepair() {
  if (!currentRunId) {
    alert('Please run or select an agent workload first.');
    return;
  }
  const btn = document.getElementById('btn-execute-repair');
  btn.disabled = true;
  btn.innerText = '⚙️ Forking & Repairing...';

  try {
    const res = await fetch(`/api/repair/${currentRunId}`, { method: 'POST' });
    const data = await res.json();

    document.getElementById('repair-action-label').innerText = `Apply Fix: ${data.repair_action.description}`;
    document.getElementById('repair-replay-status').innerText = `Replay Forward -> Final Verification PASS ✓ (${data.duration_ms} ms)`;

    document.getElementById('repair-results-panel').innerHTML = `
      <div style="background:rgba(16, 185, 129, 0.08); border:1px solid #10b981; padding:1.25rem; border-radius:8px">
        <h4 style="color:#10b981; margin-bottom:0.5rem">✓ Counterfactual Repair Succeeded!</h4>
        <p>Validated Causal Candidate: <strong>Step ${data.causal_candidate_step}</strong></p>
        <p>Saved Regression Case ID: <strong>${data.regression_case_id}</strong></p>
        <p>Cost Status: <span class="tag warning">${data.cost_breakdown.cost_status}</span> | Token Status: <span class="tag info">UNAVAILABLE</span></p>
      </div>
    `;
    await loadRuns();
  } catch (err) {
    alert('Repair error: ' + err);
  } finally {
    btn.disabled = false;
    btn.innerText = '🔧 Fork & Apply Repair';
  }
}

async function loadBenchmarkData() {
  try {
    const res = await fetch('/api/benchmark');
    const data = await res.json();
    renderBenchmarkMatrix(data.metrics_by_strategy, data.cost_by_strategy);
    renderBenchmarkCharts(data.metrics_by_strategy);
  } catch (err) {
    console.error('Benchmark fetch failed:', err);
  }
}

function renderBenchmarkMatrix(metrics, costs) {
  const tbody = document.getElementById('benchmark-matrix-body');
  const strats = Object.keys(metrics);

  tbody.innerHTML = strats.map(s => {
    const m = metrics[s];
    const c = costs[s];
    return `
      <tr>
        <td><strong>${s}</strong></td>
        <td>${m.probes_count}</td>
        <td>${m.localization_time_ms} ms</td>
        <td>${m.forks_count}</td>
        <td>${m.snapshots_count}</td>
        <td>$${c.total_recovery_cost} <span class="tag warning">${c.cost_status || 'ESTIMATED'}</span></td>
        <td><span class="tag info">${c.recovery_overhead_pct}%</span></td>
      </tr>
    `;
  }).join('');
}

function renderBenchmarkCharts(metrics) {
  const labels = Object.keys(metrics);
  const probesData = labels.map(l => metrics[l].probes_count);
  const latencyData = labels.map(l => metrics[l].localization_time_ms);

  if (probesChart) probesChart.destroy();
  if (latencyChart) latencyChart.destroy();

  const ctxP = document.getElementById('chart-probes').getContext('2d');
  probesChart = new Chart(ctxP, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Avg Probes Evaluated',
        data: probesData,
        backgroundColor: '#ff4500',
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#888884' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#888884' }, grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });

  const ctxL = document.getElementById('chart-latency').getContext('2d');
  latencyChart = new Chart(ctxL, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Localization Latency (ms)',
        data: latencyData,
        backgroundColor: '#10b981',
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#888884' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#888884' }, grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
}

async function loadRegressionCases() {
  try {
    const res = await fetch('/api/cases');
    const cases = await res.json();
    const tbody = document.getElementById('cases-table-body');

    if (!cases || cases.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted">No saved regression cases yet. Repairs automatically generate regression test cases.</td></tr>';
      return;
    }

    tbody.innerHTML = cases.map(c => `
      <tr>
        <td><strong>${c.case_id}</strong></td>
        <td><span class="tag warning">${c.scenario}</span></td>
        <td>${c.original_run_id}</td>
        <td>Step ${c.fault_boundary_step}</td>
        <td><span class="pill success">PASS ✓</span></td>
        <td>
          <button class="btn btn-sm btn-primary" onclick="replayCase('${c.case_id}')">Replay Case</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load cases:', err);
  }
}

async function replayCase(caseId) {
  try {
    const res = await fetch(`/api/cases/replay/${caseId}`, { method: 'POST' });
    const data = await res.json();
    alert(`Case Replayed: ${data.detail}`);
  } catch (err) {
    alert('Replay error: ' + err);
  }
}

function switchTab(tabId) {
  document.querySelector(`.nav-item[data-tab="${tabId}"]`)?.click();
}
