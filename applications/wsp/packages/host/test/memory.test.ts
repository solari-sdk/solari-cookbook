// SPDX-License-Identifier: AGPL-3.0-only
// What the host costs the computer it runs on, measured rather than claimed:
// one child process is the host, a scripted day of threads and turns goes
// through it, and what it still holds once it goes quiet is read off V8 after
// a full collection. Resident size is read too and named on a red run, but it
// is not the budget: an empty node is already past this budget in mapped
// binary alone (41 MB on this Linux runner), and resident size follows V8's
// high water mark rather than what the host kept.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "../../protocol/test/source-files.js";
import { DIST, describeWithDists, distOf } from "./built-bin.js";

/** What the host may still hold after a day of agents has gone through it. The landing page prints this number and
 * nothing else names it: lower it here and the page goes red until it says the same thing. */
const HOST_MEMORY_BUDGET_MB = 40;

/** The one page that quotes the budget. */
const PAGE = join("apps", "www", "src", "sections", "story.tsx");

/** The scripted day: four threads a person keeps open, thirty turns each, forty deltas a turn. That is past the
 * transcript ring's 5000 events, so the host is measured with every cap it has already full. */
const THREADS = 4;
const TURNS_PER_THREAD = 30;
const DELTAS_PER_TURN = 40;

interface Reading {
  heldMb: number;
  rssMb: number;
  turns: number;
}

/** The host as its own process: the wiring `wsp up` builds, a local workspace, and one harness that answers with a
 * turn's worth of events instead of starting an agent, so no machine and no agent is involved in the measurement. */
const hostScript = (home: string): string => `
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRuntime, jsonFileStore } from ${JSON.stringify(distOf("runtime"))};
import { startHost, localWiring, stateWriterHere } from ${JSON.stringify(DIST)};
import { fakeCopier, NoProviderBackend } from ${JSON.stringify(distOf("engine"))};
import { DAEMON_VERSION } from ${JSON.stringify(distOf("protocol"))};

const home = ${JSON.stringify(home)};
const webDir = join(home, "web");
mkdirSync(join(webDir, "assets"), { recursive: true });
writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\\n");
writeFileSync(join(webDir, "index.html"), '<!doctype html><html><head><script type="module" crossorigin src="/assets/app.js"></script></head><body><div id="root"></div><script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script></body></html>');
const statePath = join(home, "state", "state.json");
mkdirSync(join(home, "state"), { recursive: true });

let nth = 0;
const scripted = () => ({
  steers: false,
  start: ({ onEvent }) => {
    const sessionId = \`00000000-0000-4000-8000-\${String(++nth).padStart(12, "0")}\`;
    const finished = (async () => {
      onEvent({ type: "session.start", sessionId });
      for (let i = 0; i < ${DELTAS_PER_TURN}; i++) onEvent({ type: "turn.delta", sessionId, kind: "text", text: "token ".repeat(16) });
      const result = { status: "completed", text: "done" };
      onEvent({ type: "turn.done", sessionId, result });
      onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return result;
    })();
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

// The copy road and the daemon beside the host are the fakes: every workspace here is a copy, this checkout stages
// no daemon binary, and what is measured is the host's own bookkeeping.
const copier = fakeCopier(ask => {
  cpSync(ask.from, ask.to, { recursive: true });
  return { road: "clonefile", path: ask.to, base: "0".repeat(40), branch: "main", fetched: true, carried: "deps-and-config", excluded: [...ask.exclude], bytes: 1024, ms: 1 };
});
const daemon = async () => ({ version: DAEMON_VERSION, road: { url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }, sysSamples: async () => () => {}, close: async () => {} });
const runtime = createRuntime({
  backend: new NoProviderBackend(),
  local: localWiring(home, undefined, daemon, statePath, copier),
  store: jsonFileStore(statePath, stateWriterHere()),
  adapters: { claude: scripted },
});
const host = await startHost({ runtime, webDir, port: 0, wsPort: 0, statePath });
// A workspace is one project's copy, so the measurement records a repo of its own here and copies it.
const folder = join(home, "repo");
mkdirSync(folder, { recursive: true });
execFileSync("git", ["init", "-q", folder]);
const project = await host.addProject(folder);
const workspace = await host.createWorkspace("here", undefined, project.id);

const turn = async (thread) => {
  const handle = await runtime.sessions.start(workspace.id, { prompt: "go", harness: "claude", ...(thread === undefined ? {} : { thread }) });
  await handle.finished?.catch(() => {});
  return handle.view().threadId ?? handle.view().id;
};
const threads = [];
for (let t = 0; t < ${THREADS}; t++) threads.push(await turn(undefined));
for (let n = 1; n < ${TURNS_PER_THREAD}; n++) for (const thread of threads) await turn(thread);

// The host writes its index and its transcripts behind a queue. What it holds is only known once it has been left
// alone the way an idle minute leaves it, so this reads until two collections agree. external covers the buffers a
// socket frame and a queued write live in, arrayBuffers among them, which the heap alone does not count.
const held = () => {
  global.gc();
  global.gc();
  const m = process.memoryUsage();
  return (m.heapUsed + m.external) / 1048576;
};
let before = Infinity;
let after = held();
for (let i = 0; i < 60 && Math.abs(before - after) > 1; i++) {
  await sleep(250);
  before = after;
  after = held();
}
console.log(\`measured \${JSON.stringify({ heldMb: +after.toFixed(1), rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1), turns: ${THREADS * TURNS_PER_THREAD} })}\`);
await host.close();
process.exit(0);
`;

/** How long a measuring run may take before it is ended, so a host that will not close cannot outlive this file. */
const RUN_CAP_MS = 240_000;

/** Runs a script under a node of its own with collection exposed, and answers with everything it said. */
function ran(script: string, home: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], {
      cwd: home,
      env: { ...process.env, HOME: home, WSP_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    const cap = setTimeout(() => child.kill("SIGKILL"), RUN_CAP_MS);
    child.once("error", error => {
      clearTimeout(cap);
      reject(error);
    });
    child.once("exit", code => {
      clearTimeout(cap);
      resolve({ out, code });
    });
  });
}

const reading = (out: string, who: string): Reading => {
  const line = out.split("\n").find(l => l.startsWith("measured "));
  if (line === undefined) throw new Error(`${who} printed no measurement:\n${out}`);
  return JSON.parse(line.slice("measured ".length)) as Reading;
};

describe("the page prints the budget the test guards", () => {
  it("names the same number the host is held to", () => {
    const page = readFileSync(join(ROOT, PAGE), "utf8");
    expect(page, `${PAGE} must quote ${HOST_MEMORY_BUDGET_MB} MB, the budget this file guards`).toMatch(new RegExp(`\\b${HOST_MEMORY_BUDGET_MB} MB\\b`));
  });
});

describeWithDists("what the host holds after a day of agents", ["host", "runtime", "engine"], () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-memory-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it(`stays under ${HOST_MEMORY_BUDGET_MB} MB with ${THREADS * TURNS_PER_THREAD} turns through it`, async () => {
    const empty = await ran('global.gc(); console.log(`measured ${JSON.stringify({ heldMb: 0, rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1), turns: 0 })}`)', home);
    expect(empty.code, `an empty node on this runner said: ${empty.out}`).toBe(0);
    const floor = reading(empty.out, "an empty node");
    const run = await ran(hostScript(home), home);
    expect(run.code, run.out).toBe(0);
    const held = reading(run.out, "the host");
    expect(
      held.heldMb,
      `the host held ${held.heldMb} MB after ${held.turns} turns (resident ${held.rssMb} MB, an empty node on this runner ${floor.rssMb} MB)`,
    ).toBeLessThanOrEqual(HOST_MEMORY_BUDGET_MB);
  }, 300_000);
});
