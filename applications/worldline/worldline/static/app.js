const app = document.querySelector("#app")

const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")

const shortHash = (value) => (value ? value.slice(0, 12) : "—")
const branchById = (run, id) => run.branches.find((branch) => branch.candidate_id === id)

function branchCard(branch, winnerId) {
  const passed = branch.checks.filter((check) => check.passed).length
  const selected = branch.candidate_id === winnerId
  return `
    <button type="button" class="branch-card ${branch.status} ${selected ? "selected" : ""}"
      data-branch="${escapeHtml(branch.candidate_id)}" aria-pressed="${selected}">
      <span class="branch-topline">
        <span class="branch-state">${selected ? "selected" : branch.status}</span>
        <span class="branch-score">${branch.score.toFixed(2)}</span>
      </span>
      <strong>${escapeHtml(branch.label)}</strong>
      <span>${escapeHtml(branch.hypothesis)}</span>
      <span class="branch-meta">${passed}/${branch.checks.length} checks · ${branch.action_count} actions · ${branch.duration_ms}ms</span>
    </button>`
}

function detailPanel(branch) {
  return `
    <section class="evidence-panel" aria-labelledby="evidence-title">
      <div class="evidence-copy">
        <span class="eyebrow">Branch evidence</span>
        <h2 id="evidence-title">${escapeHtml(branch.label)}</h2>
        <p>${escapeHtml(branch.hypothesis)}</p>
        <dl class="evidence-stats">
          <div><dt>Score</dt><dd>${branch.score.toFixed(2)}</dd></div>
          <div><dt>Artifact</dt><dd>${shortHash(branch.artifact_sha256)}</dd></div>
          <div><dt>Phase</dt><dd>${escapeHtml(branch.phase)}</dd></div>
        </dl>
        <div class="checks">
          ${branch.checks.map((check) => `
            <article class="check ${check.passed ? "pass" : "fail"}">
              <span class="check-icon" aria-hidden="true">${check.passed ? "✓" : "×"}</span>
              <div><strong>${escapeHtml(check.label)}</strong>
                <small>expected ${escapeHtml(check.expected)} · observed ${escapeHtml(check.actual)}</small>
              </div>
            </article>`).join("")}
        </div>
      </div>
      <figure class="screen-frame">
        ${branch.screenshot ? `<img src="${escapeHtml(branch.screenshot)}" alt="Evidence screenshot for ${escapeHtml(branch.label)}" />` : "<div>No screenshot captured</div>"}
        <figcaption>Independent artifact and screen evidence</figcaption>
      </figure>
    </section>`
}

function render(run) {
  const winner = branchById(run, run.winner_id) || run.branches[0]
  const passedBranches = run.branches.filter((branch) => branch.status === "pass").length
  const commitChecks = run.commit?.checks?.filter((check) => check.passed).length || 0
  const commitTotal = run.commit?.checks?.length || 0
  app.innerHTML = `
    <header class="hero">
      <nav><a class="wordmark" href="#top" aria-label="Worldline home"><span>W</span> Worldline</a><span class="run-id">${escapeHtml(run.run_id)}</span></nav>
      <div class="hero-grid" id="top">
        <div>
          <span class="eyebrow">Speculative execution for agents</span>
          <h1>Fork the world.<br /><em>Commit the proof.</em></h1>
          <p>${escapeHtml(run.task_detail)}</p>
        </div>
        <div class="status-orbit" aria-label="Run status ${escapeHtml(run.status)}">
          <span>${escapeHtml(run.status)}</span><strong>${run.branches.length}</strong><small>worldlines explored</small>
        </div>
      </div>
    </header>

    <section class="proof-strip" aria-label="Run summary">
      <div><span>Provider</span><strong>${escapeHtml(run.environment.provider)}</strong></div>
      <div><span>Checkpoint</span><strong>${escapeHtml(run.environment.checkpoint_id)}</strong></div>
      <div><span>Valid branches</span><strong>${passedBranches}/${run.branches.length}</strong></div>
      <div><span>Cleanup</span><strong class="${run.cleanup.succeeded ? "ok" : "bad"}">${run.cleanup.succeeded ? "verified" : "failed"}</strong></div>
    </section>

    <section class="tree-section">
      <div class="section-heading"><span class="eyebrow">Decision tree</span><h2>One state. Three futures.</h2><p>Select a branch to inspect the evidence used by the judge.</p></div>
      <div class="checkpoint"><span class="checkpoint-dot"></span><div><small>CHECKPOINT</small><strong>${shortHash(run.environment.base_sha256)}</strong></div></div>
      <div class="branch-grid">${run.branches.map((branch) => branchCard(branch, run.winner_id)).join("")}</div>
      <div class="commit-line"><span></span><div><small>COMMIT BY REPLAY</small><strong>${escapeHtml(run.commit?.label || "No branch committed")}</strong></div></div>
      <article class="commit-proof ${run.status === "committed" ? "verified" : "rejected"}">
        <div><span class="eyebrow">Authoritative outcome</span><h3>${run.status === "committed" ? "Winner replay verified" : "No result committed"}</h3></div>
        <dl>
          <div><dt>Replay checks</dt><dd>${commitChecks}/${commitTotal}</dd></div>
          <div><dt>Artifact digest</dt><dd>${shortHash(run.commit?.artifact_sha256)}</dd></div>
          <div><dt>Resource cleanup</dt><dd>${run.cleanup.succeeded ? "verified" : "failed"}</dd></div>
        </dl>
      </article>
    </section>

    <div id="branch-detail">${detailPanel(winner)}</div>

    <footer><span>Worldline ${escapeHtml(run.engine_version)}</span><span>Artifact judge &gt; agent narration</span></footer>`

  document.querySelectorAll("[data-branch]").forEach((button) => {
    button.addEventListener("click", () => {
      const branch = branchById(run, button.dataset.branch)
      if (!branch) return
      document.querySelectorAll("[data-branch]").forEach((item) => item.setAttribute("aria-pressed", "false"))
      button.setAttribute("aria-pressed", "true")
      document.querySelector("#branch-detail").innerHTML = detailPanel(branch)
      document.querySelector("#branch-detail").scrollIntoView({ behavior: "smooth", block: "start" })
    })
  })
}

fetch("run.json", { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  })
  .then(render)
  .catch((error) => {
    app.innerHTML = `<div class="fatal"><strong>Evidence could not be loaded.</strong><span>${escapeHtml(error.message)}</span></div>`
  })
