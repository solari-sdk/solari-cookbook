// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the creation screen in its failed state
// with as many log lines as the query asks for (?lines=20) in either theme
// (?theme=light), so a test can measure what jsdom cannot lay out.
import { createRoot } from "react-dom/client";
import type { Creation, CreationLine } from "../../src/protocol/store";
import { WorkspaceCreation } from "../../src/shell/WorkspaceCreation";
import "../../src/index.css";
import "../../src/themes/index";

const params = new URLSearchParams(window.location.search);
const count = Number(params.get("lines") ?? "2");
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

const MESSAGES = [
  "starting beta on ascii",
  "hostname set to beta",
  "Waiting for the daemon to answer on its port.",
  "Daemon reachable; preparing the workspace checkout and the harness configuration directory.",
];

// What the runtime refuses a fork with at the machine cap: the failing log line and the detail are one sentence.
const FAILED = "both machine slots are in use: first, t-cap. Pause one or wait for a nap.";

const lines: CreationLine[] = Array.from({ length: count }, (_, i) => ({
  stage: i === count - 1 ? "failed" : "daemon-answering",
  message: i === count - 1 ? FAILED : MESSAGES[i % MESSAGES.length]!,
  at: new Date(Date.UTC(2026, 8, 5, 12, 31, i)).toISOString(),
  elapsedMs: 800 * (i + 1),
}));

const creation: Creation = {
  key: "creating:beta",
  askedAt: Date.now(),
  name: "beta",
  workspaceId: "ws_beta",
  lines,
  failed: {
    title: "The provider refused: no more workspaces can run there now",
    detail: FAILED,
  },
};

createRoot(document.getElementById("root")!).render(<WorkspaceCreation creation={creation} />);
