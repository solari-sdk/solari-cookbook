// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeHost } from "@wsp/collect";
import { loginPathLine } from "@wsp/protocol";
import { createRuntime, jsonFileStore } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { up, type CliIO } from "../src/cli.js";
import { stateWriterHere } from "../src/version.js";
import { LAUNCHD_PATH, loginEnvOf, needsLoginPath, takeLoginPath } from "../src/login-path.js";
import type { HostHandle } from "../src/server.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";

const PAGE = `<!doctype html>
<html><head></head><body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>
</body></html>
`;

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));

describe("the login shell PATH", () => {
  let dir: string;
  /** The file a fake shell touches when it runs, so a shell that must never run can be shown not to have. */
  let ran: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-login-path-"));
    ran = join(dir, "ran");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in for the person's login shell: it records that it ran, then does what the case needs. */
  function fakeShell(body: string): string {
    const file = join(dir, "shell");
    writeFileSync(file, `#!/bin/sh\n: > ${JSON.stringify(ran)}\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  const launchd = (): NodeJS.ProcessEnv => ({ PATH: LAUNCHD_PATH.join(":") });

  /** A login shell already run, handed to the rules that are about what it printed rather than about running one:
   * a real process for those makes the case wait on a loaded machine and cost the shell's own time limit. */
  const printing = (out: string) => (): Promise<string> => Promise.resolve(out);

  it("a host handed launchd's PATH runs the login shell and takes what it prints", async () => {
    const env: NodeJS.ProcessEnv = { ...launchd(), SHELL: fakeShell(`printf %s "/Users/dev/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"`) };
    const lines: string[] = [];
    await takeLoginPath({ env, log: l => lines.push(l) });
    // The one case that runs a process, so it is the one that proves the shell is really launched and read.
    expect(existsSync(ran)).toBe(true);
    expect(env["PATH"]).toBe("/Users/dev/.local/bin:/opt/homebrew/bin:/usr/bin:/bin");
    expect(lines).toEqual([]);
  });

  it("the four system folders in any order and nothing else are launchd's set; every other PATH was meant by whoever set it", () => {
    expect(needsLoginPath({ PATH: "/sbin:/usr/bin:/usr/sbin:/bin" })).toBe(true);
    expect(needsLoginPath({ PATH: LAUNCHD_PATH.join(":") })).toBe(true);
    expect(needsLoginPath({ PATH: `/opt/homebrew/bin:${LAUNCHD_PATH.join(":")}` })).toBe(false);
    expect(needsLoginPath({ PATH: "/usr/bin:/bin:/usr/sbin" })).toBe(false);
    expect(needsLoginPath({ PATH: "/usr/bin:/usr/bin:/bin:/sbin" })).toBe(false);
    // What a service manager's unit file or a test runner hands down: fewer folders than a login shell gives, but
    // chosen, so the rc files are never read over it.
    expect(needsLoginPath({ PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" })).toBe(false);
    expect(needsLoginPath({})).toBe(false);
  });

  it("a host whose PATH is not launchd's set never runs the shell", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/opt/homebrew/bin:/usr/bin:/bin", SHELL: "/bin/zsh" };
    const lines: string[] = [];
    let asked = false;
    await takeLoginPath({
      env,
      log: l => lines.push(l),
      read: async () => {
        asked = true;
        return "/should/not/be/read";
      },
    });
    expect(asked).toBe(false);
    expect(env["PATH"]).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(lines).toEqual([]);
  });

  it("a shell that fails leaves the PATH alone and says so in one line, with only the first line of the failure", async () => {
    const env: NodeJS.ProcessEnv = { ...launchd(), SHELL: "/bin/zsh" };
    const lines: string[] = [];
    await takeLoginPath({ env, log: l => lines.push(l), read: () => Promise.reject(new Error("Command failed: /bin/zsh -ilc\nrc file said something on the way out")) });
    expect(env["PATH"]).toBe(LAUNCHD_PATH.join(":"));
    expect(lines).toEqual([loginPathLine("/bin/zsh failed: Command failed: /bin/zsh -ilc")]);
  });

  it("a shell that prints nothing leaves the PATH alone and says so in one line", async () => {
    const env: NodeJS.ProcessEnv = { ...launchd(), SHELL: "/bin/zsh" };
    const lines: string[] = [];
    await takeLoginPath({ env, log: l => lines.push(l), read: printing("") });
    expect(env["PATH"]).toBe(LAUNCHD_PATH.join(":"));
    expect(lines).toEqual([loginPathLine("/bin/zsh printed nothing")]);
  });

  it("no SHELL at all leaves the PATH alone and says so in one line", async () => {
    const env = launchd();
    const lines: string[] = [];
    await takeLoginPath({ env, log: l => lines.push(l) });
    expect(env["PATH"]).toBe(LAUNCHD_PATH.join(":"));
    expect(lines).toEqual([loginPathLine("SHELL names no login shell")]);
  });

  it("an rc file that greets the person first costs nothing: the PATH is what follows the last newline", async () => {
    const env: NodeJS.ProcessEnv = { ...launchd(), SHELL: "/bin/zsh" };
    await takeLoginPath({ env, log: () => {}, read: printing("hello from your dotfiles\n/Users/dev/.local/bin:/usr/bin") });
    expect(env["PATH"]).toBe("/Users/dev/.local/bin:/usr/bin");
  });

  it("wsp up on launchd's PATH resolves it before the host serves, and every lookup after it inherits it", async () => {
    const home = join(dir, "custom");
    const webDir = join(home, "web");
    mkdirSync(webDir, { recursive: true });
    writeFileSync(join(webDir, "index.html"), PAGE);
    const statePath = join(home, "state", "state.json");
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ goldens: { default: SEALED_GOLDEN } }));
    // A tool only the login shell's PATH names, so a lookup that finds it read the resolved PATH and nothing else.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "wsp-fake-tool"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "wsp-fake-tool"), 0o755);

    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_login_path_key");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", home);
    vi.stubEnv("SHELL", fakeShell(`printf %s ${JSON.stringify(`${bin}:${LAUNCHD_PATH.join(":")}`)}`));
    vi.stubEnv("PATH", LAUNCHD_PATH.join(":"));

    const io: CliIO = { log: () => {}, error: () => {}, ask: noPrompt, askSecret: noPrompt };
    const handle: HostHandle | undefined = await up(io, {
      port: 0,
      wsPort: 0,
      statePath,
      webDir,
      runtime: createRuntime({ backend: stubBackend(), store: jsonFileStore(statePath, stateWriterHere()), adapters: {} }),
    });
    if (handle === undefined) throw new Error("up refused a state with a sealed golden");
    try {
      expect(process.env["PATH"]).toBe(`${bin}:${LAUNCHD_PATH.join(":")}`);
      expect(await nodeHost().exec.which("wsp-fake-tool")).toBe(true);
      expect((await fetch(`http://127.0.0.1:${handle.port}/`)).status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  // The order law src/login-path.ts states, held road by road. The read is once per process, so saying it on each
  // road is free.
  it("every road that builds a runtime awaits the read before it", () => {
    const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    // Each top level declaration of cli.ts, so a road is judged on its own body and not on the file's order.
    const roads = source.split(/\n(?=(?:export )?(?:async )?function |(?:export )?const [A-Za-z]+: )/);
    const builders = roads.filter(road => road.includes("makeRuntime(") && !road.includes("export function makeRuntime("));
    expect(builders.length).toBeGreaterThan(0);
    for (const road of builders) {
      const name = /^(?:export )?(?:async )?(?:function|const) (\w+)/.exec(road)?.[1] ?? road.slice(0, 40);
      expect(road.indexOf("adoptLoginPath("), `${name} builds a runtime without reading the login shell PATH first`).toBeGreaterThanOrEqual(0);
      expect(road.indexOf("adoptLoginPath("), `${name} builds its runtime before the read`).toBeLessThan(road.indexOf("makeRuntime("));
    }
  });

  // The wsp command needs no PATH and a launch is expected to have written it by the time a window is up, so the
  // read, which waits on a shell, goes after it and before everything that does need the PATH.
  it("the desktop window writes the command, then reads the PATH, then opens anything", () => {
    const main = readFileSync(new URL("../../../apps/desktop/src/main.ts", import.meta.url), "utf8");
    const shim = main.indexOf("installCommand();");
    const read = main.indexOf("await adoptLoginPath(");
    const gate = main.indexOf("await locate()");
    expect(shim, "the desktop never writes the wsp command").toBeGreaterThanOrEqual(0);
    expect(read, "the desktop never reads the login shell PATH").toBeGreaterThanOrEqual(0);
    expect(shim, "the read waits on a shell before the command is written").toBeLessThan(read);
    expect(read, "the setup gate builds its runtime before the read").toBeLessThan(gate);
  });
});

describe("the login shell's environment", () => {
  it("reads every variable env -0 printed, past a greeting an rc file printed first, a value's newlines kept", () => {
    const out = ["Welcome back\nHOME=/Users/ada", "TOKEN=sk-x-fake", "MULTI=one\ntwo", "EMPTY=", ""].join("\0");
    expect(loginEnvOf(out)).toEqual({ HOME: "/Users/ada", TOKEN: "sk-x-fake", MULTI: "one\ntwo", EMPTY: "" });
    expect(loginEnvOf("")).toEqual({});
  });
});

describe("the login shell's environment", () => {
  it("is read even when an rc file waits on its input, since the shell's input is closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-login-env-"));
    const shell = join(dir, "sh");
    writeFileSync(shell, `#!/bin/sh\nread answer\nprintf 'WSP_FROM_RC=yes\\0'\n`);
    chmodSync(shell, 0o755);
    const was = process.env["SHELL"];
    process.env["SHELL"] = shell;
    vi.resetModules();
    try {
      const { loginEnv } = await import("../src/login-path.js");
      const started = Date.now();
      expect(await loginEnv()).toMatchObject({ WSP_FROM_RC: "yes" });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      if (was === undefined) delete process.env["SHELL"];
      else process.env["SHELL"] = was;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
