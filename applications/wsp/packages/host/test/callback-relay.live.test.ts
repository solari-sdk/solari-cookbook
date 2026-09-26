// SPDX-License-Identifier: AGPL-3.0-only
// The relay against one real machine: a builder prepared the wizard's way, the
// shim deployed with the daemon, three sign-ins started from a daemon pty (the
// wsp terminal's road) and taken only as far as the browser open on this
// computer and the callback reaching the guest listener. No login completes:
// the callbacks carry a bogus code, and the tools reject it themselves.
import { DAEMON_PORT, SolariBackend, isReserved, type PreviewReach } from "@wsp/engine";
import { connectDaemon, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import type { GoldenBuilderView } from "@wsp/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { LIVE, liveEnv } from "../../engine/test/live.js";
import { DAEMON_DEPLOYED_LINE, GUEST_ENVS, deployDaemon } from "../src/doctor.js";
import { startCallbackRelay, systemOpener, type CallbackRelay } from "../src/relay.js";

const LABEL = { wsp: "1", "wsp-test": "callback-relay-live" };
const GH = "2.97.0";
const NODE22 = "22.23.2";
const WRANGLER = "4.106.0";
const MCP_SERVER = "https://mcp.linear.app/mcp";

const INSTALL_GH = `set -e
arch="$(uname -m)"
case "$arch" in x86_64) gharch=amd64 ;; aarch64) gharch=arm64 ;; esac
curl -fsSL -o /tmp/gh.tgz https://github.com/cli/cli/releases/download/v${GH}/gh_${GH}_linux_$gharch.tar.gz
tar -xzf /tmp/gh.tgz -C /tmp
install -m 0755 /tmp/gh_${GH}_linux_$gharch/bin/gh /usr/local/bin/gh
`;

// Runs detached: a REST exec that outlives the edge's patience returns 502, so the poller reads a done file.
const INSTALL = `set -e
export PATH=/usr/local/bin:$PATH
arch="$(uname -m)"
case "$arch" in x86_64) nodearch=x64 ;; aarch64) nodearch=arm64 ;; esac
curl -fsSL -o /tmp/node22.tgz https://nodejs.org/dist/v${NODE22}/node-v${NODE22}-linux-$nodearch.tar.gz
mkdir -p /opt/node22
tar -xzf /tmp/node22.tgz -C /opt/node22 --strip-components=1
export PATH=/opt/node22/bin:$PATH
npm i -g wrangler@${WRANGLER} --no-audit --no-fund
npx -y mcp-remote@0.8.3 --help >/dev/null 2>&1 || true
echo RELAY_INSTALL_DONE > /tmp/relay-install.done
`;

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

describe.runIf(LIVE)("callback relay (live)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);
  let machineId: string | undefined;

  afterAll(async () => {
    if (!LIVE || machineId === undefined) return;
    await backend.get(machineId).then(m => m.kill()).catch(() => {});
  });

  it("gh device page opens here; wrangler on [::1]:8976 and an MCP OAuth callback come back through the tunnel", { timeout: 900_000 }, async () => {
    const t0 = Date.now();
    // Created bare, not through golden.prepare: the provider's pool refused the builder's disk.size today
    // (measured 2026-09-04, "host pool ... does not support: disk.size"), and the relay only needs a daemon.
    const machine = await backend.create({ kind: "sandbox", template: "base", cpu: 2, memMb: 4096, envs: GUEST_ENVS, labels: { ...LABEL, createdAt: new Date().toISOString() } });
    machineId = machine.id;
    const { token } = await deployDaemon(machine);
    const notes: string[] = [`machine ${machine.id} created and ${DAEMON_DEPLOYED_LINE} deployed at ${Date.now() - t0}ms`];
    // The relay dials builders through the runtime; this one stands in for a prepared builder with the same reach shape.
    const builder: GoldenBuilderView = { id: machine.id, name: "relay-live", kind: "sandbox", createdAt: new Date().toISOString(), size: { cpu: 2, memMb: 4096 } };
    let minted: PreviewReach | undefined;
    const base = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const rt: Runtime = {
      ...base,
      golden: {
        ...base.golden,
        builderReach: async () => {
          minted ??= await machine.previewUrl!(DAEMON_PORT);
          return { url: minted.url, expiresAt: minted.expiresAt, daemonToken: token };
        },
      },
    };

    const opened: string[] = [];
    const lines: string[] = [];
    const real = systemOpener();
    let relay: CallbackRelay | undefined;
    let link: ReturnType<typeof connectDaemon> | undefined;
    try {
      const shim = await machine.exec("ls -l /usr/local/bin/wsp-open /usr/local/bin/xdg-open; cat /etc/profile.d/wsp-open.sh; test -S /root/.wsp/open.sock && echo SOCK_OK");
      expect(shim.stdout).toContain("SOCK_OK");
      expect(shim.stdout).toContain("xdg-open -> /usr/local/bin/wsp-open");
      expect(shim.stdout).toContain("unset DISPLAY");

      // Scripts go through a quoted heredoc so the guest shell, not this one, expands their variables.
      const gh = await machine.exec(`bash <<'WSP_INSTALL'\n${INSTALL_GH}WSP_INSTALL\ngh --version | head -1`, { timeoutMs: 120_000 });
      expect(gh.stdout).toContain(`gh version ${GH}`);
      await machine.exec(`cat > /tmp/relay-install.sh <<'WSP_INSTALL'\n${INSTALL}WSP_INSTALL\nsetsid nohup bash /tmp/relay-install.sh > /tmp/relay-install.log 2>&1 < /dev/null & sleep 0.5`);
      const installed = async (): Promise<void> => {
        const installDeadline = Date.now() + 600_000;
        for (;;) {
          const done = await machine.exec("cat /tmp/relay-install.done 2>/dev/null");
          if (done.stdout.includes("RELAY_INSTALL_DONE")) break;
          if (Date.now() > installDeadline) {
            const log = await machine.exec("tail -c 600 /tmp/relay-install.log");
            throw new Error(`tool install timed out: ${log.stdout}`);
          }
          await new Promise(r => setTimeout(r, 5000));
        }
        const versions = await machine.exec("/opt/node22/bin/node --version; PATH=/opt/node22/bin:$PATH wrangler --version");
        notes.push(`installed at ${Date.now() - t0}ms: ${gh.stdout.trim()}, node ${versions.stdout.trim().replace(/\n/g, ", wrangler ")}`);
      };

      relay = startCallbackRelay({
        runtime: rt,
        builder,
        log: l => lines.push(l),
        // Every flow here is typed into a pty, the TUI case that opens without a click.
        autoOpen: () => true,
        // The device page is the one URL safe to put in the real browser: it asks for a code and nothing was typed.
        openUrl: async url => {
          opened.push(url);
          return url === "https://github.com/login/device" ? real(url) : true;
        },
      });

      const reach = await rt.golden.builderReach(builder.id);
      let out = "";
      let cursorAsks = 0;
      let ptyId = "";
      link = connectDaemon({
        previewUrl: reach.url,
        token: reach.daemonToken!,
        heartbeatMs: 10_000,
        onEvent: e => {
          if (e.type !== "pty.data") return;
          out += e.data;
          // gh's prompter asks where the cursor is and blocks until a terminal answers; there is none here.
          const asks = e.data.split("\x1b[6n").length - 1;
          for (let i = 0; i < asks; i++) {
            cursorAsks++;
            void link!.request("pty.write", { ptyId, data: "\x1b[1;1R" });
          }
        },
      });
      await link.ready;
      const created = await link.request("pty.create", { cols: 140, rows: 40 });
      ptyId = String(created["ptyId"]);
      await link.request("pty.attach", { ptyId });
      const type = (s: string) => link!.request("pty.write", { ptyId, data: s });
      const shown = () => strip(out);
      const seen = (re: RegExp, ms: number, what: string) =>
        until(() => re.test(shown()), ms, what).catch((e: Error) => {
          throw new Error(`${e.message}; terminal showed: ${JSON.stringify(shown().slice(-1500))}`);
        });

      await type("echo BROWSER=$BROWSER DISPLAY=${DISPLAY:-unset}\n");
      await seen(/BROWSER=\/usr\/local\/bin\/wsp-open DISPLAY=unset/, 15_000, "pty env");

      // gh: device flow, BROWSER honoured, argv [url]; gh blocks until the shim exits.
      await type("gh auth login --web --hostname github.com --git-protocol https --skip-ssh-key\n");
      await seen(/Authenticate Git/, 30_000, "gh git prompt");
      await type("n\n");
      await seen(/Press Enter to open/, 30_000, "gh open prompt");
      const tGh = Date.now();
      await type("\n");
      await until(() => opened.includes("https://github.com/login/device"), 30_000, "gh device URL on the laptop");
      notes.push(`gh: device URL reached the laptop opener ${Date.now() - tGh}ms after Enter; cursor queries answered: ${cursorAsks}; forwards=${JSON.stringify(relay.forwards())}`);
      await seen(/one-time code|First copy/, 30_000, "gh code line");
      expect(relay.forwards()).toEqual([]);
      await type("\x03");
      await new Promise(r => setTimeout(r, 1000));
      await installed();

      // wrangler: execs xdg-open by name, listens on [::1]:8976 only under Node 22.
      out = "";
      await type("PATH=/opt/node22/bin:$PATH wrangler login\n");
      await until(() => opened.some(u => u.includes("redirect_uri=http%3A%2F%2Flocalhost%3A8976")), 60_000, "wrangler URL on the laptop");
      await until(() => relay!.forwards().some(f => f.port === 8976), 15_000, "laptop listener on 8976");
      const ss = await machine.exec("ss -ltn | grep 8976");
      expect(ss.stdout).toContain("[::1]:8976");
      const cb = await fetch("http://localhost:8976/oauth/callback?code=not-a-real-code&state=not-the-state", { redirect: "manual" });
      const cbBody = await cb.text();
      await until(() => /state|invalid|error|denied|mismatch/i.test(shown()) || cb.status >= 400, 20_000, "wrangler's answer to the bogus callback");
      notes.push(`wrangler: guest listener ${ss.stdout.trim().split(/\s+/).slice(3, 4).join("")}, laptop callback answered HTTP ${cb.status} (${cbBody.length} bytes), terminal: ${shown().split("\n").filter(l => /state|invalid|error|denied|mismatch/i.test(l)).slice(0, 2).join(" | ").slice(0, 200)}`);
      await type("\x03");
      await new Promise(r => setTimeout(r, 1000));

      // mcp-remote: its port is 3335 + hash(server URL), stable per server; redirect_uri uses localhost.
      out = "";
      await type(`PATH=/opt/node22/bin:$PATH npx -y mcp-remote@0.8.3 ${MCP_SERVER}\n`);
      await until(() => opened.some(u => u.includes(encodeURIComponent(MCP_SERVER))), 120_000, "MCP authorize URL on the laptop");
      const mcpUrl = opened.find(u => u.includes(encodeURIComponent(MCP_SERVER)))!;
      const mcpPort = Number(new URL(new URL(mcpUrl).searchParams.get("redirect_uri")!).port);
      await until(() => relay!.forwards().some(f => f.port === mcpPort), 15_000, `laptop listener on ${mcpPort}`);
      const mcpCb = await fetch(`http://127.0.0.1:${mcpPort}/oauth/callback?code=not-a-real-code&state=not-the-state`, { redirect: "manual" });
      const mcpBody = await mcpCb.text();
      notes.push(`mcp-remote: callback port ${mcpPort}, laptop callback answered HTTP ${mcpCb.status} (${mcpBody.length} bytes)`);
      await type("\x03");

      // Never the URL, in any line.
      const joined = lines.join("\n");
      expect(joined).not.toMatch(/github\.com|cloudflare|linear/);
      expect(lines.filter(l => l.includes("opened a sign-in page")).length).toBeGreaterThanOrEqual(3);
      expect(lines.some(l => l.includes("forwarding localhost:8976"))).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[callback-relay.live]\n  ${notes.join("\n  ")}\n  host lines:\n    ${lines.join("\n    ")}`);
    } finally {
      link?.close();
      await relay?.close();
      await machine.kill().catch(() => {});
      const gone = await backend.get(machine.id).then(m => m.state(), () => "gone" as const);
      expect(gone).toBe("gone");
      machineId = undefined;
    }
    const alive = (await backend.list()).filter(m => !isReserved(m.labels) && m.labels["wsp-test"] === LABEL["wsp-test"] && m.state !== "gone");
    expect(alive).toEqual([]);
  });
});
