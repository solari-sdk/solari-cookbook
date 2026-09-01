import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { runBrowserPulse } from "./benchmarks/browserPulse.js";
import { runSandboxPulse } from "./benchmarks/sandboxPulse.js";
import { runDesktopPulse } from "./benchmarks/desktopPulse.js";
import { browserReference, sandboxReference } from "./reference.js";
import type { PulseEvent, PulseMode } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

const app = express();
app.use(express.static(publicDir));

app.get("/api/reference", (_req, res) => {
  res.json({ browser: browserReference, sandbox: sandboxReference });
});

app.get("/api/pulse", async (req, res) => {
  const mode = String(req.query.mode ?? "browser") as PulseMode;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: PulseEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Keeps intermediary proxies from closing an idle SSE connection.
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15000);

  try {
    if (mode === "browser") {
      await runBrowserPulse(send);
    } else if (mode === "sandbox") {
      await runSandboxPulse(send);
    } else if (mode === "desktop") {
      await runDesktopPulse(send);
    } else {
      send({ type: "error", message: `Unknown mode: ${mode}` });
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

app.listen(config.port, () => {
  console.log(`pulse listening on http://localhost:${config.port}`);
});
