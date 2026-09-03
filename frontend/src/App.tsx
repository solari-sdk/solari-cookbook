import { useEffect, useState } from "react";
import "./App.css";

type Status = {
  running: boolean;
  phase: string;
  message: string;
  bug: {
    expected: string;
    actual: string;
    quantity: number;
  } | null;
  rootCause: {
    file: string;
    cause: string;
    explanation: string;
    suggestedFix: string;
  } | null;
  patch: {
    file: string;
    applied: boolean;
    diff: string;
  } | null;
  tests: boolean;
  verification: {
    expected: string;
    actual: string;
    verified: boolean;
  } | null;
  error: string | null;
};

const initialStatus: Status = {
  running: false,
  phase: "IDLE",
  message: "Ready to run PatchPilot",
  bug: null,
  rootCause: null,
  patch: null,
  tests: false,
  verification: null,
  error: null,
};

const steps = [
  {
    number: "01",
    key: "BUG_DISCOVERY",
    title: "Bug Discovery",
    subtitle: "Reproduce failure",
  },
  {
    number: "02",
    key: "ROOT_CAUSE",
    title: "Root Cause",
    subtitle: "Inspect source",
  },
  {
    number: "03",
    key: "PATCH",
    title: "Patch",
    subtitle: "Modify code",
  },
  {
    number: "04",
    key: "TESTS",
    title: "Tests",
    subtitle: "Validate fix",
  },
  {
    number: "05",
    key: "VERIFY",
    title: "Verify",
    subtitle: "Fresh browser",
  },
];

function App() {
  const [status, setStatus] =
    useState<Status>(initialStatus);

  async function fetchStatus() {
    try {
      const response = await fetch(
        "http://localhost:4000/api/status"
      );

      if (!response.ok) {
        throw new Error(
          "Failed to fetch status"
        );
      }

      const data: Status =
        await response.json();

      setStatus(data);
    } catch (error) {
      console.error(
        "Status error:",
        error
      );
    }
  }

  async function runPatchPilot() {
    try {
      await fetch(
        "http://localhost:4000/api/run",
        {
          method: "POST",
        }
      );

      await fetchStatus();
    } catch (error) {
      console.error(
        "Failed to start PatchPilot:",
        error
      );
    }
  }

  useEffect(() => {
    fetchStatus();

    const interval = setInterval(
      fetchStatus,
      500
    );

    return () => {
      clearInterval(interval);
    };
  }, []);

  const verificationComplete =
    status.verification?.verified === true;

  const getStepState = (
    index: number
  ) => {
    const phaseOrder = [
      "BUG_DISCOVERY",
      "ROOT_CAUSE",
      "PATCH",
      "TESTS",
      "VERIFY",
    ];

    const currentIndex =
      phaseOrder.indexOf(status.phase);

    if (
      verificationComplete &&
      index === 4
    ) {
      return "complete";
    }

    if (
      currentIndex !== -1 &&
      index < currentIndex
    ) {
      return "complete";
    }

    if (
      currentIndex === index
    ) {
      return "active";
    }

    if (
      index === 0 &&
      status.bug
    ) {
      return "complete";
    }

    if (
      index === 1 &&
      status.rootCause
    ) {
      return "complete";
    }

    if (
      index === 2 &&
      status.patch?.applied
    ) {
      return "complete";
    }

    if (
      index === 3 &&
      status.tests
    ) {
      return "complete";
    }

    return "pending";
  };

  return (
    <div className="app">

      {/* BACKGROUND EFFECTS */}

      <div className="background-grid" />
      <div className="glow glow-one" />
      <div className="glow glow-two" />

      {/* HEADER */}

      <header className="topbar">

        <div className="brand">
          <div className="brand-mark">
            <span />
            <span />
            <span />
          </div>

          <div>
            <div className="brand-name">
              PATCHPILOT
            </div>

            <div className="brand-subtitle">
              AUTONOMOUS SOFTWARE ENGINEERING
            </div>
          </div>
        </div>

        <div className="topbar-right">

          <div className="solari-chip">
            <span className="chip-dot" />
            SOLARI ENGINE
          </div>

          <div className="online">
            <span className="online-dot" />
            {status.running
              ? "AGENT ACTIVE"
              : "SYSTEM ONLINE"}
          </div>

        </div>
      </header>

      <main className="main">

        {/* HERO */}

        <section className="hero">

          <div className="hero-copy">

            <div className="eyebrow">
              <span className="eyebrow-line" />
              AUTONOMOUS DEBUGGING AGENT
            </div>

            <h1>
              Find the bug.
              <br />
              <span>Fix the bug.</span>
              <br />
              Prove the fix.
            </h1>

            <p className="hero-description">
              PatchPilot reproduces real application
              failures, investigates source code,
              applies a patch, runs tests, and
              independently verifies the result
              inside a fresh browser session.
            </p>

            {status.running && (
              <div className="agent-message">
                <div className="agent-pulse">
                  <span />
                </div>

                <div>
                  <small>
                    PATCHPILOT AGENT
                  </small>

                  <strong>
                    {status.message}
                  </strong>
                </div>
              </div>
            )}

          </div>

          <div className="hero-action">

            <div className="agent-orbit">

              <div className="orbit-ring ring-one" />
              <div className="orbit-ring ring-two" />

              <div className="agent-core">
                <div className="core-icon">
                  ✦
                </div>
                <span>AI</span>
              </div>

            </div>

            <button
              className={`run-button ${
                status.running
                  ? "running"
                  : ""
              }`}
              onClick={runPatchPilot}
              disabled={status.running}
            >
              <span className="button-icon">
                {status.running
                  ? "◌"
                  : "▶"}
              </span>

              {status.running
                ? "AGENT RUNNING"
                : verificationComplete
                ? "RUN AGAIN"
                : "RUN PATCHPILOT"}

              {!status.running && (
                <span className="button-arrow">
                  ↗
                </span>
              )}
            </button>

          </div>

        </section>

        {/* PIPELINE */}

        <section className="pipeline-section">

          <div className="section-label">
            <span>01</span>
            AGENT PIPELINE
          </div>

          <div className="pipeline">

            {steps.map(
              (step, index) => {

                const state =
                  getStepState(index);

                return (
                  <div
                    className="pipeline-item"
                    key={step.key}
                  >

                    <div
                      className={`pipeline-step ${state}`}
                    >

                      <div className="step-icon">

                        {state ===
                        "complete"
                          ? "✓"
                          : step.number}

                      </div>

                      <div className="step-info">
                        <strong>
                          {step.title}
                        </strong>

                        <span>
                          {step.subtitle}
                        </span>
                      </div>

                    </div>

                    {index <
                      steps.length - 1 && (
                      <div
                        className={`pipeline-connector ${
                          state ===
                            "complete"
                            ? "complete"
                            : ""
                        }`}
                      />
                    )}

                  </div>
                );
              }
            )}

          </div>

        </section>

        {/* MAIN CARDS */}

        <section className="cards-grid">

          {/* BUG */}

          <div className="panel bug-panel">

            <PanelHeader
              label="BUG DISCOVERY"
              status={
                status.bug
                  ? "BUG FOUND"
                  : "WAITING"
              }
              danger={
                Boolean(status.bug)
              }
            />

            <div className="bug-values">

              <Metric
                label="EXPECTED"
                value={
                  status.bug?.expected ||
                  "—"
                }
              />

              <div className="metric-divider">
                ≠
              </div>

              <Metric
                label="OBSERVED"
                value={
                  status.bug?.actual ||
                  "—"
                }
                danger
              />

            </div>

            <div className="bug-message">

              <span className="failure-icon">
                {status.bug
                  ? "×"
                  : "○"}
              </span>

              <div>
                <strong>
                  {status.bug
                    ? "Application behavior is incorrect"
                    : "Waiting for browser reproduction"}
                </strong>

                <span>
                  {status.bug
                    ? `Quantity ${status.bug.quantity} should produce ${status.bug.expected}`
                    : "PatchPilot will interact with the application automatically."}
                </span>
              </div>

            </div>

          </div>

          {/* ROOT CAUSE */}

          <div className="panel">

            <PanelHeader
              label="ROOT CAUSE"
              status={
                status.rootCause
                  ? "IDENTIFIED"
                  : "WAITING"
              }
            />

            <div className="source-file">

              <span className="file-icon">
                TS
              </span>

              <span>
                {status.rootCause?.file ||
                  "src/cart.ts"}
              </span>

              {status.rootCause && (
                <span className="source-dot">
                  ●
                </span>
              )}

            </div>

            <div className="cause-title">
              {status.rootCause?.cause ||
                "Waiting for source analysis..."}
            </div>

            <p className="panel-description">
              {status.rootCause?.explanation ||
                "PatchPilot will inspect the application source and identify the failing logic."}
            </p>

          </div>

          {/* PATCH */}

          <div className="panel patch-panel">

            <PanelHeader
              label="AUTONOMOUS PATCH"
              status={
                status.patch?.applied
                  ? "APPLIED"
                  : "WAITING"
              }
            />

            <div className="code-header">

              <div>
                <span className="code-dot red" />
                <span className="code-dot yellow" />
                <span className="code-dot green" />
              </div>

              <span>
                {status.patch?.file ||
                  "src/cart.ts"}
              </span>

            </div>

            <div className="code">

              {status.patch?.diff ? (
                status.patch.diff
                  .trim()
                  .split("\n")
                  .map(
                    (
                      line,
                      index
                    ) => {

                      const removed =
                        line.startsWith(
                          "- "
                        );

                      const added =
                        line.startsWith(
                          "+ "
                        );

                      return (
                        <div
                          key={index}
                          className={`code-line ${
                            removed
                              ? "removed"
                              : added
                              ? "added"
                              : ""
                          }`}
                        >
                          <span className="line-symbol">
                            {removed
                              ? "−"
                              : added
                              ? "+"
                              : " "}
                          </span>

                          <span>
                            {line
                              .replace(
                                /^[-+] /,
                                ""
                              )}
                          </span>
                        </div>
                      );
                    }
                  )
              ) : (
                <div className="code-empty">
                  Waiting for autonomous patch...
                </div>
              )}

            </div>

          </div>

          {/* TESTS */}

          <div className="panel tests-panel">

            <PanelHeader
              label="VALIDATION"
              status={
                status.tests
                  ? "PASSED"
                  : "WAITING"
              }
            />

            <div
              className={`test-visual ${
                status.tests
                  ? "passed"
                  : ""
              }`}
            >

              <div className="test-check">
                {status.tests
                  ? "✓"
                  : "…"}
              </div>

              <div className="test-copy">

                <strong>
                  {status.tests
                    ? "All tests passed"
                    : "Tests pending"}
                </strong>

                <span>
                  {status.tests
                    ? "Patch validation successful"
                    : "Waiting for code validation"}
                </span>

              </div>

            </div>

            <div className="test-bar">
              <span
                className={
                  status.tests
                    ? "filled"
                    : ""
                }
              />
            </div>

            <div className="test-footer">
              <span>
                UNIT TEST SUITE
              </span>

              <strong>
                {status.tests
                  ? "PASS"
                  : "—"}
              </strong>
            </div>

          </div>

        </section>

        {/* VERIFICATION */}

        <section className="verification-panel">

          <div className="verification-header">

            <div>

              <div className="section-label">
                <span>02</span>
                INDEPENDENT VERIFICATION
              </div>

              <h2>
                Fresh Solari Browser Session
              </h2>

              <p>
                The original user workflow is replayed
                against the patched application.
              </p>

            </div>

            <div
              className={`verification-status ${
                verificationComplete
                  ? "verified"
                  : ""
              }`}
            >
              <span>
                {verificationComplete
                  ? "✓"
                  : "○"}
              </span>

              {verificationComplete
                ? "FIX VERIFIED"
                : "PENDING"}

            </div>

          </div>

          <div className="verification-body">

            <div className="browser-card">

              <div className="browser-top">

                <div className="browser-dots">
                  <span />
                  <span />
                  <span />
                </div>

                <div className="browser-address">
                  solari://patched-application
                </div>

                <span className="secure">
                  ● LIVE
                </span>

              </div>

              <div className="browser-content">

                <span className="browser-label">
                  CART CALCULATION
                </span>

                <div className="browser-calculation">

                  <strong>
                    3 × $10
                  </strong>

                  <span>→</span>

                  <strong
                    className={
                      verificationComplete
                        ? "success-text"
                        : ""
                    }
                  >
                    {status.verification
                      ?.actual ||
                      "—"}
                  </strong>

                </div>

              </div>

            </div>

            <div className="verification-arrow">
              →
            </div>

            <div className="proof-card">

              <span className="proof-label">
                EXPECTED RESULT
              </span>

              <strong>
                {status.verification
                  ?.expected ||
                  "$30"}
              </strong>

              <span className="proof-sub">
                Browser assertion
              </span>

            </div>

          </div>

          <div
            className={`final-banner ${
              verificationComplete
                ? "success"
                : ""
            }`}
          >

            <div className="final-icon">
              {verificationComplete
                ? "✓"
                : "○"}
            </div>

            <div>

              <span>
                PATCHPILOT RESULT
              </span>

              <strong>
                {verificationComplete
                  ? "FIX VERIFIED"
                  : status.message}
              </strong>

            </div>

            {verificationComplete && (
              <div className="final-proof">
                $10 → $30
              </div>
            )}

          </div>

        </section>

        {/* ERROR */}

        {status.error && (
          <div className="error-panel">

            <span>!</span>

            <div>
              <strong>
                PATCHPILOT ERROR
              </strong>

              <p>
                {status.error}
              </p>
            </div>

          </div>
        )}

      </main>

      <footer className="footer">

        <span>
          PATCHPILOT
        </span>

        <span className="footer-separator">
          /
        </span>

        <span>
          BROWSER
        </span>

        <span>→</span>

        <span>
          SANDBOX
        </span>

        <span>→</span>

        <span>
          PATCH
        </span>

        <span>→</span>

        <span>
          TEST
        </span>

        <span>→</span>

        <span>
          VERIFY
        </span>

        <div className="footer-right">
          AUTONOMOUS SOFTWARE ENGINEERING
        </div>

      </footer>

    </div>
  );
}

function PanelHeader({
  label,
  status,
  danger = false,
}: {
  label: string;
  status: string;
  danger?: boolean;
}) {
  return (
    <div className="panel-header">

      <span className="panel-label">
        {label}
      </span>

      <span
        className={`panel-status ${
          danger ? "danger" : ""
        } ${
          status === "PASSED" ||
          status === "APPLIED" ||
          status === "IDENTIFIED"
            ? "success"
            : ""
        }`}
      >
        <i />
        {status}
      </span>

    </div>
  );
}

function Metric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="metric">

      <span>
        {label}
      </span>

      <strong
        className={
          danger
            ? "danger-value"
            : ""
        }
      >
        {value}
      </strong>

    </div>
  );
}

export default App;