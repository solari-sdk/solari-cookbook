const MODES = {
  browser: {
    steps: ["create", "connect", "navigate", "release"],
    label: "create \u2192 connect \u2192 navigate \u2192 release",
    unit: "ms",
    referenceKey: "browser",
  },
  sandbox: {
    steps: ["create", "run", "release"],
    label: "create \u2192 run \u2192 release",
    unit: "s",
    referenceKey: "sandbox",
  },
  desktop: {
    steps: ["create", "ready", "release"],
    label: "create \u2192 ready \u2192 release",
    unit: "ms",
    referenceKey: null,
  },
};

const els = {
  tabs: document.querySelectorAll(".tab"),
  steps: document.getElementById("steps"),
  total: document.getElementById("total"),
  methodLabel: document.getElementById("methodLabel"),
  runBtn: document.getElementById("runBtn"),
  copyBtn: document.getElementById("copyBtn"),
  status: document.getElementById("status"),
  referenceTitle: document.getElementById("referenceTitle"),
  referenceUnit: document.getElementById("referenceUnit"),
  referenceRows: document.getElementById("referenceRows"),
  referenceNote: document.getElementById("referenceNote"),
};

let currentMode = "browser";
let referenceData = null;
let activeSource = null;
let lastResult = null;

function buildSteps(mode) {
  const cfg = MODES[mode];
  els.steps.innerHTML = "";
  for (const stage of cfg.steps) {
    const cell = document.createElement("div");
    cell.className = "step";
    cell.dataset.stage = stage;
    cell.innerHTML = `
      <span class="step-label">${stage}</span>
      <span class="step-value is-pending">--</span>
    `;
    els.steps.appendChild(cell);
  }
}

function setStepState(stage, state, ms) {
  const cell = els.steps.querySelector(`[data-stage="${stage}"]`);
  if (!cell) return;
  cell.classList.remove("is-active", "is-done");
  if (state === "active") {
    cell.classList.add("is-active");
  } else if (state === "done") {
    cell.classList.add("is-done");
    const value = cell.querySelector(".step-value");
    value.textContent = `${ms}ms`;
    value.classList.remove("is-pending");
  }
}

function resetSteps() {
  buildSteps(currentMode);
  const first = els.steps.querySelector(".step");
  if (first) first.classList.add("is-active");
}

function formatTotal(mode, totalMs) {
  if (mode === "sandbox") {
    return { value: (totalMs / 1000).toFixed(1), unit: "s" };
  }
  return { value: String(Math.round(totalMs)), unit: "ms" };
}

function renderReferenceTable(mode) {
  const cfg = MODES[mode];
  const table = cfg.referenceKey ? referenceData?.[cfg.referenceKey] : null;

  if (!table) {
    els.referenceTitle.textContent = "solari only, no public field to compare against yet";
    els.referenceUnit.textContent = "";
    els.referenceRows.innerHTML = "";
    els.referenceNote.textContent =
      "solari has not published a cross-provider desktop benchmark. the number above is solari's own, measured live.";
    return;
  }

  els.referenceTitle.textContent = table.title;
  els.referenceUnit.textContent = table.unit;
  els.referenceRows.innerHTML = table.rows
    .map((row) => {
      const liveMarkup = row.isLive
        ? '<span class="live-dot"></span>'
        : "";
      const rowClass = row.isLive ? "reference-row is-live-row" : "reference-row";
      return `
        <div class="${rowClass}">
          <span class="name">${liveMarkup}${row.name}</span>
          <span class="value">${row.value}${table.unit}</span>
        </div>
      `;
    })
    .join("");
  els.referenceNote.innerHTML = `solari's row above is measured live by this page. the rest are published on <a href="${table.sourceUrl}" target="_blank" rel="noopener">getsolari.com</a> (${table.sourceLabel}) and are not run by this server.`;
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.classList.remove("is-error", "is-live");
  if (kind) els.status.classList.add(kind);
}

function switchMode(mode) {
  if (activeSource) {
    activeSource.close();
    activeSource = null;
  }
  currentMode = mode;
  lastResult = null;
  els.copyBtn.disabled = true;
  els.runBtn.disabled = false;

  for (const tab of els.tabs) {
    const isActive = tab.dataset.mode === mode;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  }

  els.methodLabel.textContent = MODES[mode].label;
  els.total.innerHTML = `0<span class="unit">${MODES[mode].unit}</span>`;
  setStatus("idle");
  resetSteps();
  renderReferenceTable(mode);
}

function runPulse() {
  if (activeSource) return;

  els.runBtn.disabled = true;
  els.copyBtn.disabled = true;
  lastResult = null;
  resetSteps();
  setStatus("connecting to solari\u2026");

  const source = new EventSource(`/api/pulse?mode=${currentMode}`);
  activeSource = source;

  const cfg = MODES[currentMode];
  let stageIndex = 0;

  source.onmessage = (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "stage") {
      setStepState(payload.stage, "done", payload.ms);
      stageIndex += 1;
      const next = cfg.steps[stageIndex];
      if (next) setStepState(next, "active");
      setStatus(`${payload.stage} done in ${payload.ms}ms`, "is-live");
    }

    if (payload.type === "done") {
      const formatted = formatTotal(currentMode, payload.totalMs);
      els.total.innerHTML = `${formatted.value}<span class="unit">${formatted.unit}</span>`;
      setStatus("live, just now", "is-live");
      lastResult = { mode: currentMode, totalMs: payload.totalMs };
      els.copyBtn.disabled = false;
      els.runBtn.disabled = false;
      source.close();
      activeSource = null;
    }

    if (payload.type === "error") {
      setStatus(payload.message, "is-error");
      els.runBtn.disabled = false;
      source.close();
      activeSource = null;
    }
  };

  source.onerror = () => {
    if (!lastResult) {
      setStatus("connection dropped before finishing", "is-error");
    }
    els.runBtn.disabled = false;
    source.close();
    activeSource = null;
  };
}

async function copyResult() {
  if (!lastResult) return;
  const formatted = formatTotal(lastResult.mode, lastResult.totalMs);
  const text = `solari ${lastResult.mode} pulse: ${formatted.value}${formatted.unit}, live just now - verified with pulse, built on the solari sdk`;
  try {
    await navigator.clipboard.writeText(text);
    const original = els.copyBtn.textContent;
    els.copyBtn.textContent = "copied";
    setTimeout(() => {
      els.copyBtn.textContent = original;
    }, 1500);
  } catch (err) {
    setStatus("could not copy, select the number manually", "is-error");
  }
}

for (const tab of els.tabs) {
  tab.addEventListener("click", () => switchMode(tab.dataset.mode));
}

els.runBtn.addEventListener("click", runPulse);
els.copyBtn.addEventListener("click", copyResult);

async function init() {
  resetSteps();
  try {
    const res = await fetch("/api/reference");
    referenceData = await res.json();
  } catch (err) {
    referenceData = null;
  }
  renderReferenceTable(currentMode);
}

init();
