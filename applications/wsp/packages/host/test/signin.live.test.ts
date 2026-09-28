// SPDX-License-Identifier: AGPL-3.0-only
// wsp init end to end against the real account with a two-login manifest: the
// builder is prepared the wizard's way from a fresh state directory, gh and
// Codex are installed on it, and the sign-in stage is driven from a scripted
// terminal up to each provider's device page, which opens on this computer.
// Nothing is authorized, both status checks say not signed in, the skips land
// in the notes, and the run reaches the hand-off. The host's start-up sweep is
// not run here (it lists the whole account); the callback relay is wired the
// way startHost wires it, openLine included.
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Manifest } from "@wsp/collect";
import { SolariBackend, type BackendPricing } from "@wsp/engine";
import { createRuntime, jsonFileStore } from "@wsp/runtime";
import { afterAll, describe, expect, it } from "vitest";
import { LIVE, liveEnv } from "../../engine/test/live.js";
import { DAEMON_DEPLOYED_LINE, deployDaemon } from "../src/doctor.js";
import { stateWriterHere } from "../src/version.js";
import { importResultPath } from "../src/init-import.js";
import { runInit, type InitIO, type InitOptions } from "../src/init.js";
import { startCallbackRelay, systemOpener, type CallbackRelay } from "../src/relay.js";

const GH = "2.97.0";
const CODEX = "rust-v0.153.2";
// sha256 of the x86_64 tarballs, read from the release assets on 2026-09-04; the guest is x86_64.
const GH_SHA256 = "a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112";
const CODEX_SHA256 = "e8cd1160071f725d2a10cab81073dd6818fc8b096372125d27ef6e66fdf0979e";
const DEVICE_PAGES = [/^https:\/\/github\.com\/login\/device$/, /^https:\/\/auth\.openai\.com\/[^?]*device[^?]*$/];

const INSTALL = `set -e
arch="$(uname -m)"
case "$arch" in x86_64) gharch=amd64; cxarch=x86_64 ;; aarch64) gharch=arm64; cxarch=aarch64 ;; esac
curl -fsSL -o /tmp/gh.tgz https://github.com/cli/cli/releases/download/v${GH}/gh_${GH}_linux_$gharch.tar.gz
[ "$arch" != x86_64 ] || echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c -
tar -xzf /tmp/gh.tgz -C /tmp
install -m 0755 /tmp/gh_${GH}_linux_$gharch/bin/gh /usr/local/bin/gh
curl -fsSL -o /tmp/codex.tgz https://github.com/openai/codex/releases/download/${CODEX}/codex-$cxarch-unknown-linux-musl.tar.gz
[ "$arch" != x86_64 ] || echo "${CODEX_SHA256}  /tmp/codex.tgz" | sha256sum -c -
mkdir -p /tmp/codexdir
tar -xzf /tmp/codex.tgz -C /tmp/codexdir
install -m 0755 /tmp/codexdir/codex-* /usr/local/bin/codex
echo SIGNIN_INSTALL_DONE > /tmp/signin-install.done
`;

// Detached: a REST exec that outlives the edge's patience returns 502, so the host hook polls for the done file.
const SETUP = `cat > /tmp/signin-install.sh <<'WSP_INSTALL'\n${INSTALL}WSP_INSTALL\nsetsid nohup bash /tmp/signin-install.sh > /tmp/signin-install.log 2>&1 < /dev/null & sleep 0.5; true`;

const MANIFEST: Manifest = {
  entries: [
    { rung: "identity", id: "identity/git-user", label: "git name and email", paths: ["~/.gitconfig"], bytes: 40, default: "bring", required: true },
    { rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", paths: ["~/.config/gh/hosts.yml"], bytes: 100, default: "skip" },
    { rung: "logins", id: "logins/codex", label: "Codex login", group: "Agent logins", paths: ["~/.codex/auth.json"], bytes: 300, default: "skip" },
  ],
};

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
/** Device codes never leave the terminal, not even in a failure message. */
const redact = (s: string): string => s.replace(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/g, "[code]").replace(/\?[^\s]*/g, "?[query]");

async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

describe.runIf(LIVE)("sign-in stage (live)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);
  let builderId: string | undefined;
  const dirs: string[] = [];

  afterAll(async () => {
    if (!LIVE) return;
    if (builderId !== undefined) await backend.get(builderId).then(m => m.kill()).catch(() => {});
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("gh by device code and Codex by device auth run in the terminal up to the provider's page; both status checks say not signed in; skips land in the notes; the hand-off comes", { timeout: 1_500_000 }, async () => {
    const t0 = Date.now();
    const home = mkdtempSync(join(tmpdir(), "wsp-signin-live-home-"));
    const wspHome = mkdtempSync(join(tmpdir(), "wsp-signin-live-state-"));
    dirs.push(home, wspHome);
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Live Test\n");
    const statePath = join(wspHome, "state.json");

    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns?: number; rows?: number };
    output.columns = 140;
    output.rows = 40;
    let text = "";
    let cursorAsks = 0;
    output.on("data", (c: Buffer) => {
      const s = c.toString();
      text += s;
      // The tools ask where the cursor is and block until a terminal answers; there is none here.
      const asks = s.split("\x1b[6n").length - 1;
      for (let i = 0; i < asks; i++) {
        cursorAsks++;
        input.write("\x1b[1;1R");
      }
    });
    const shown = (): string => strip(text);
    /** Where the transcript stands now; a later seen() looks only past it, since prompts and lines repeat. */
    const mark = (): number => shown().length;
    const seen = (re: RegExp, ms: number, what: string, from = 0): Promise<void> =>
      until(() => re.test(shown().slice(from)), ms, what).catch((e: Error) => {
        throw new Error(`${e.message}; terminal showed: ${JSON.stringify(redact(shown().slice(-1500)))}`);
      });
    const type = (s: string): void => void input.write(s);

    const opened: string[] = [];
    const openedHere: string[] = [];
    const real = systemOpener();
    // Only a device page ever reaches the real browser: it asks for a code and nothing is typed there.
    const gatedOpen = async (url: string): Promise<boolean> => {
      opened.push(url);
      if (!DEVICE_PAGES.some(re => re.test(url))) return true;
      openedHere.push(url);
      return real(url);
    };
    const io: InitIO = { input, output, stderr: new PassThrough(), isTTY: true, env: {}, open: gatedOpen, signals: new EventEmitter(), exit: () => {} };

    const hostLines: string[] = [];
    const notes: string[] = [];
    let relay: CallbackRelay | undefined;
    const pricing: BackendPricing = backend.pricing;
    const opts: InitOptions = {
      yes: false,
      collect: async () => MANIFEST,
      recipe: async () => ({ version: 1, at: new Date().toISOString(), histories: [], rows: [] }),
      scanProject: async folder => ({ dir: folder, rows: [], candidates: [] }),
      vault: () => ({}),
    saveKeys: () => {},
      pricing,
      statePath,
      home,
      platform: "darwin",
      secrets: { read: async () => { throw new Error("no Keychain in the live test"); }, run: async () => { throw new Error("no helper in the live test"); } },
      runtime: recipe =>
        createRuntime({
          backend,
          store: jsonFileStore(statePath, stateWriterHere()),
          adapters: {},
          goldenRecipe: { ...recipe, setup: SETUP, deployDaemon: async m => deployDaemon(m).then(() => DAEMON_DEPLOYED_LINE) },
        }),
      ports: { port: 0, wsPort: 0, named: true },
      upCommand: "wsp up",
      forkCommand: "wsp new first",
      roads: () => ({
        createWorkspace: async () => { throw new Error("no workspace in this live run"); },
        addProject: async () => { throw new Error("no project in this live run"); },
        planProject: async () => { throw new Error("no project in this live run"); },
        importProject: async () => { throw new Error("no project in this live run"); },
      }),
      host: async () => { throw new Error("no host in this live run"); },
      relay: async (rt, builder, hooks) => {
        builderId = builder.id;
        notes.push(`builder ${builder.id} ready at ${Date.now() - t0}ms`);
        const machine = await backend.get(builder.id);
        await until(async () => (await machine.exec("cat /tmp/signin-install.done 2>/dev/null")).stdout.includes("SIGNIN_INSTALL_DONE"), 600_000, "gh and codex install").catch(async (e: Error) => {
          const log = await machine.exec("tail -c 600 /tmp/signin-install.log");
          throw new Error(`${e.message}: ${log.stdout}`);
        });
        const versions = await machine.exec("gh --version | head -1; codex --version");
        notes.push(`installed at ${Date.now() - t0}ms: ${versions.stdout.trim().replace(/\n/g, ", ")}`);
        relay = startCallbackRelay({
          runtime: rt,
          builder,
          autoOpen: hooks.autoOpen,
          openLine: hooks.openLine,
          openUrl: gatedOpen,
          log: line => {
            if (!hooks.onLine(line)) hostLines.push(line);
          },
        });
        return { close: async () => relay?.close() };
      },
    };

    const run = runInit(opts, io);
    try {
      await seen(/Identity/, 30_000, "the Identity screen");
      type("\r");
      await seen(/Sign-ins\s+7\/7/, 30_000, "the Sign-ins screen");
      expect(shown()).toMatch(/GitHub CLI login\s+sign in/);
      expect(shown()).toMatch(/Codex login\s+sign in/);
      type("\r");
      await seen(/Boot a \d+ vCPU/, 30_000, "the boot question");
      type("y");

      await seen(/Signing in on the machine/, 900_000, "the sign-in stage");
      notes.push(`sign-in stage started at ${Date.now() - t0}ms`);

      // gh: the default device flow. Enter lets gh run the shim; without consent nothing opens here and the host says so
      // inside the pty; o then opens the device page on this computer and arms auto-open for the rest of the command.
      await seen(/GitHub CLI login\s+gh auth login/, 30_000, "the gh header");
      await seen(/Where do you use GitHub|What account do you want to log into/, 60_000, "gh's first prompt");
      type("\r");
      await seen(/preferred protocol/, 30_000, "gh's protocol prompt");
      type("\r");
      await seen(/Authenticate Git/, 30_000, "gh's git prompt");
      type("n");
      type("\r");
      await seen(/How would you like to authenticate/, 30_000, "gh's method prompt");
      type("\r");
      await seen(/Press Enter to open https:\/\/github\.com\/login\/device/, 60_000, "gh's open prompt");
      await seen(/o opens it on this computer/, 5_000, "the o offer for gh");
      expect(opened).toEqual([]);
      type("\r");
      await seen(/press o on the link above to open it here/, 30_000, "the host's line inside the pty");
      expect(openedHere).toEqual([]);
      const tO = Date.now();
      type("o");
      await seen(/opened on this computer/, 30_000, "the o open for gh");
      expect(openedHere).toEqual(["https://github.com/login/device"]);
      notes.push(`gh: device page opened here ${Date.now() - tO}ms after o; cursor queries answered so far: ${cursorAsks}; forwards=${JSON.stringify(relay!.forwards())}`);
      type("\x03");
      await seen(/GitHub CLI login: not signed in \(gh auth status says not signed in\)/, 60_000, "gh's status check");

      // Codex: the default callback flow reaches the shim and the forward arms 1455; the consent page is never opened here.
      await seen(/Codex login\s+codex login\n/, 30_000, "the codex header");
      await seen(/forwarding localhost:1455 on this computer/, 60_000, "the 1455 forward line inside the pty");
      notes.push(`codex login: forward armed, forwards=${JSON.stringify(relay!.forwards())}, opened here so far ${openedHere.length}`);
      expect(openedHere).toHaveLength(1);
      type("\x03");
      await seen(/Codex login: not signed in \(codex login status says not signed in\)/, 60_000, "codex's status check");

      // The summary: skip gh, retry Codex with device auth, open its device page here, cancel, skip.
      await seen(/GitHub CLI login\s+r retry   s skip/, 30_000, "the gh retry prompt");
      type("s");
      await seen(/Codex login\s+r retry   f retry with codex login --device-auth   s skip/, 30_000, "the codex retry prompt");
      const atF = mark();
      type("f");
      await seen(/Codex login\s+codex login --device-auth/, 30_000, "the codex device-auth header", atF);
      await seen(/o opens it on this computer/, 90_000, "the o offer for codex device auth", atF);
      const codexUrlLine = shown().slice(atF).split("\n").filter(l => l.includes("o opens it on this computer")).at(-1) ?? "";
      const atO = mark();
      const tO2 = Date.now();
      type("o");
      await seen(/opened on this computer|could not open a browser here/, 30_000, "the o open for codex", atO);
      notes.push(`codex --device-auth: o answered ${Date.now() - tO2}ms later; opened here: ${openedHere.length}; page host: ${new URL(opened.at(-1) ?? "http://none").host}; offer line: ${redact(codexUrlLine).slice(0, 160)}`);
      const atCancel = mark();
      type("\x03");
      await seen(/Codex login: not signed in/, 60_000, "codex's second status check", atCancel);
      await seen(/Codex login\s+r retry   f retry with codex login --device-auth   s skip/, 30_000, "the second codex retry prompt", atCancel);
      type("s");

      await seen(/Opened? http:\/\/127\.0\.0\.1:\d+\//, 30_000, "the hand-off", atCancel);
      type("\r");
      const result = await run;
      expect(result.code).toBe(0);
      expect(result.logins?.map(l => [l.id, l.state, l.note])).toEqual([
        ["logins/gh", "skipped", "skipped by you"],
        ["logins/codex", "skipped", "skipped by you"],
      ]);
      const saved = JSON.parse(readFileSync(importResultPath(statePath), "utf8")) as { logins?: unknown };
      expect(saved.logins).toEqual(result.logins);
      expect(shown()).toContain("Save the golden there once the machine is the way you want it.");

      // Never a URL in a host line, never a code anywhere the test keeps.
      expect(hostLines.join("\n")).not.toMatch(/github\.com|openai/);
      for (const n of notes) expect(n).not.toMatch(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/);
      // eslint-disable-next-line no-console
      console.log(`[signin.live]\n  ${notes.join("\n  ")}\n  opened (${opened.length}): ${opened.map(u => redact(u)).join(", ")}\n  host lines outside the pty:\n    ${hostLines.join("\n    ")}`);
    } finally {
      await relay?.close();
      if (builderId !== undefined) {
        const machine = await backend.get(builderId).catch(() => undefined);
        await machine?.kill().catch(() => {});
        const gone = await backend.get(builderId).then(m => m.state(), () => "gone" as const);
        expect(gone).toBe("gone");
        // eslint-disable-next-line no-console
        console.log(`[signin.live] builder ${builderId} killed by id, state ${gone}, ${Date.now() - t0}ms total`);
      }
    }
  });
});
