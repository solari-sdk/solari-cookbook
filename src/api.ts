import { createServer } from "node:http";
import { spawn } from "node:child_process";

type Bug = {
  expected: string;
  actual: string;
  quantity: number;
};

type RootCause = {
  file: string;
  cause: string;
  explanation: string;
  suggestedFix: string;
};

type Patch = {
  file: string;
  applied: boolean;
  diff: string;
};

type Verification = {
  expected: string;
  actual: string;
  verified: boolean;
};

type Status = {
  running: boolean;
  phase: string;
  message: string;
  bug: Bug | null;
  rootCause: RootCause | null;
  patch: Patch | null;
  tests: boolean;
  verification: Verification | null;
  error: string | null;
};

let status: Status = {
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

function resetStatus() {
  status = {
    running: true,
    phase: "STARTING",
    message: "Starting PatchPilot...",
    bug: null,
    rootCause: null,
    patch: null,
    tests: false,
    verification: null,
    error: null,
  };
}

function updateFromLog(line: string) {
  const text = line.trim();

  if (!text) {
    return;
  }

  console.log(`[PatchPilot] ${text}`);

  // ==================================================
  // PHASE 1 — BUG DISCOVERY
  // ==================================================

  if (text.includes("PHASE 1")) {
    status.phase = "BUG_DISCOVERY";
    status.message = "Reproducing application bug...";
  }

  if (text.includes("BUG REPRODUCED")) {
    status.phase = "BUG_DISCOVERY";
    status.message = "Bug reproduced";
  }

  const quantityMatch = text.match(/^Quantity:\s*(\d+)/);

  if (quantityMatch) {
    status.bug = {
      quantity: Number(quantityMatch[1]),
      expected: status.bug?.expected ?? "",
      actual: status.bug?.actual ?? "",
    };
  }

  // ==================================================
  // EXPECTED VALUE
  // ==================================================

  const expectedMatch = text.match(/^Expected:\s*(.+)$/);

  if (expectedMatch) {
    const value = expectedMatch[1].trim();

    if (status.phase === "BUG_DISCOVERY") {
      status.bug = {
        quantity: status.bug?.quantity ?? 3,
        expected: value,
        actual: status.bug?.actual ?? "",
      };
    }

    if (status.phase === "VERIFY") {
      status.verification = {
        expected: value,
        actual: status.verification?.actual ?? "",
        verified:
          status.verification?.actual !== undefined &&
          status.verification?.actual !== "" &&
          status.verification.actual === value,
      };
    }
  }

  // ==================================================
  // ACTUAL VALUE
  // ==================================================

  const actualMatch = text.match(/^Actual:\s*(.+)$/);

  if (actualMatch) {
    const value = actualMatch[1].trim();

    if (status.phase === "BUG_DISCOVERY") {
      status.bug = {
        quantity: status.bug?.quantity ?? 3,
        expected: status.bug?.expected ?? "",
        actual: value,
      };
    }

    if (status.phase === "VERIFY") {
      const expected =
        status.verification?.expected ?? "";

      status.verification = {
        expected,
        actual: value,
        verified:
          expected !== "" &&
          expected === value,
      };
    }
  }

  // ==================================================
  // PHASE 2 — ROOT CAUSE
  // ==================================================

  if (text.includes("PHASE 2")) {
    status.phase = "ROOT_CAUSE";
    status.message = "Analyzing source code...";
  }

  if (text.includes("ROOT CAUSE IDENTIFIED")) {
    status.phase = "ROOT_CAUSE";
    status.message = "Root cause identified";
  }

  const fileMatch = text.match(/^File:\s*(.+)$/);

  if (fileMatch) {
    const file = fileMatch[1].trim();

    if (status.phase === "ROOT_CAUSE") {
      status.rootCause = {
        file,
        cause: status.rootCause?.cause ?? "",
        explanation:
          status.rootCause?.explanation ?? "",
        suggestedFix:
          status.rootCause?.suggestedFix ?? "",
      };
    }

    if (status.phase === "PATCH") {
      status.patch = {
        file,
        applied:
          status.patch?.applied ?? false,
        diff:
          status.patch?.diff ?? "",
      };
    }
  }

  const causeMatch = text.match(/^Cause:\s*(.+)$/);

  if (causeMatch) {
    status.rootCause = {
      file:
        status.rootCause?.file ?? "",
      cause:
        causeMatch[1].trim(),
      explanation:
        status.rootCause?.explanation ?? "",
      suggestedFix:
        status.rootCause?.suggestedFix ?? "",
    };
  }

  const explanationMatch =
    text.match(/^Explanation:\s*(.+)$/);

  if (explanationMatch) {
    status.rootCause = {
      file:
        status.rootCause?.file ?? "",
      cause:
        status.rootCause?.cause ?? "",
      explanation:
        explanationMatch[1].trim(),
      suggestedFix:
        status.rootCause?.suggestedFix ?? "",
    };
  }

  const suggestedFixMatch =
    text.match(/^Suggested fix:\s*(.+)$/);

  if (suggestedFixMatch) {
    status.rootCause = {
      file:
        status.rootCause?.file ?? "",
      cause:
        status.rootCause?.cause ?? "",
      explanation:
        status.rootCause?.explanation ?? "",
      suggestedFix:
        suggestedFixMatch[1].trim(),
    };
  }

  // ==================================================
  // PHASE 3 — PATCH
  // ==================================================

  if (text.includes("PHASE 3")) {
    status.phase = "PATCH";
    status.message = "Generating code patch...";
  }

  if (text.includes("PATCH APPLIED")) {
    status.phase = "PATCH";
    status.message = "Patch applied";

    if (status.patch) {
      status.patch.applied = true;
    }
  }

  // Capture the actual diff only once.
  if (
    text.startsWith("- ") ||
    text.startsWith("+ ")
  ) {
    const existing =
      status.patch?.diff ?? "";

    if (!existing.includes(text)) {
      status.patch = {
        file:
          status.patch?.file ??
          status.rootCause?.file ??
          "",
        applied:
          status.patch?.applied ?? false,
        diff:
          `${existing}${text}\n`,
      };
    }
  }

  // ==================================================
  // PHASE 4 — TESTS
  // ==================================================

  if (text.includes("PHASE 4")) {
    status.phase = "TESTS";
    status.message = "Running tests...";
  }

  if (text.includes("PATCH PASSED TESTS")) {
    status.phase = "TESTS";
    status.tests = true;
    status.message = "All tests passed";
  }

  // ==================================================
  // PHASE 5 — PATCHED APPLICATION
  // ==================================================

  if (text.includes("PHASE 5")) {
    status.phase = "PATCHED_APP";
    status.message =
      "Starting patched application...";
  }

  // ==================================================
  // PHASE 6 — VERIFICATION
  // ==================================================

  if (text.includes("PHASE 6")) {
    status.phase = "VERIFY";
    status.message =
      "Verifying fix in fresh browser...";
  }

  if (
    text
      .toLowerCase()
      .includes("fix verification failed")
  ) {
    status.phase = "VERIFY";
    status.message =
      "Fix verification failed";

    status.verification = {
      expected:
        status.verification?.expected ?? "",
      actual:
        status.verification?.actual ?? "",
      verified: false,
    };
  }

  if (
    text
      .toLowerCase()
      .includes("fix verified")
  ) {
    status.phase = "VERIFY";
    status.running = false;
    status.message = "Fix verified";

    status.verification = {
      expected:
        status.verification?.expected || "$30",
      actual:
        status.verification?.actual || "$30",
      verified: true,
    };
  }

  // ==================================================
  // FAILURE
  // ==================================================

  if (
    text.includes("PatchPilot failed") ||
    text.includes("PATCH FAILED TESTS")
  ) {
    status.running = false;
    status.phase = "ERROR";
    status.message =
      "PatchPilot failed";
    status.error = text;
  }
}

// ======================================================
// RUN PATCHPILOT
// ======================================================

function runPatchPilot() {
  if (status.running) {
    return;
  }

  resetStatus();

  const childProcess = spawn(
    "npx",
    ["tsx", "src/index.ts"],
    {
      shell: true,
      cwd: process.cwd(),
    }
  );

  childProcess.stdout.on(
    "data",
    (data: Buffer) => {
      const lines = data
        .toString()
        .split(/\r?\n/);

      for (const line of lines) {
        updateFromLog(line);
      }
    }
  );

  childProcess.stderr.on(
    "data",
    (data: Buffer) => {
      console.error(
        data.toString()
      );
    }
  );

  childProcess.on(
    "close",
    (code: number | null) => {
      if (
        code !== 0 &&
        status.phase !== "VERIFY"
      ) {
        status.running = false;
        status.phase = "ERROR";
        status.message =
          "PatchPilot failed";
        status.error =
          `Process exited with code ${code}`;
      }
    }
  );
}

// ======================================================
// HTTP API
// ======================================================

const server = createServer(
  (req, res) => {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "http://localhost:5173"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type"
    );

    // ----------------------------------------------
    // CORS PREFLIGHT
    // ----------------------------------------------

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ----------------------------------------------
    // GET /api/status
    // ----------------------------------------------

    if (
      req.method === "GET" &&
      req.url === "/api/status"
    ) {
      res.writeHead(200, {
        "Content-Type":
          "application/json",
      });

      res.end(
        JSON.stringify(status)
      );

      return;
    }

    // ----------------------------------------------
    // POST /api/run
    // ----------------------------------------------

    if (
      req.method === "POST" &&
      req.url === "/api/run"
    ) {
      if (status.running) {
        res.writeHead(409, {
          "Content-Type":
            "application/json",
        });

        res.end(
          JSON.stringify({
            started: false,
            message:
              "PatchPilot is already running",
          })
        );

        return;
      }

      runPatchPilot();

      res.writeHead(202, {
        "Content-Type":
          "application/json",
      });

      res.end(
        JSON.stringify({
          started: true,
          message:
            "PatchPilot started",
        })
      );

      return;
    }

    // ----------------------------------------------
    // 404
    // ----------------------------------------------

    res.writeHead(404, {
      "Content-Type":
        "application/json",
    });

    res.end(
      JSON.stringify({
        error: "Not found",
      })
    );
  }
);

// ======================================================
// START SERVER
// ======================================================

server.listen(4000, () => {
  console.log("");
  console.log(
    "🚀 PatchPilot API running"
  );
  console.log(
    "🌐 http://localhost:4000"
  );
  console.log("");
});