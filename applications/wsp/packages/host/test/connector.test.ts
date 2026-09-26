// SPDX-License-Identifier: AGPL-3.0-only
// The connector: a release pinned by sha256 and fetched into the state
// folder, and a child this process started, recorded by pid and stopped by
// that pid alone. Nothing here pipes a download into a shell.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUDFLARED, connectorArgs, ensureCloudflared, fetchPinned, pinnedCloudflared, quickHostname, startConnector, stopRecordedConnector, type PinnedBinary } from "../src/connector.js";

let dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wsp-${tag}-`));
  dirs.push(dir);
  return dir;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A stand-in for the release: bytes of this test's own making, pinned by their own sha. */
function pinFor(bytes: Uint8Array, extra: Partial<PinnedBinary> = {}): PinnedBinary {
  return { version: "9999.1.0", url: "https://example.invalid/cloudflared", sha256: sha256(bytes), ...extra };
}

/** A script that stands in for the connector: it writes down how it was called and what it was given, says what
 * cloudflared says and then waits to be stopped. */
function fakeConnector(dir: string, banner: string, sleepSeconds = 30): string {
  const bin = join(dir, "fake-cloudflared");
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" > "${join(dir, "argv")}"\necho "$TUNNEL_TOKEN" > "${join(dir, "token")}"\nenv > "${join(dir, "env")}"\n>&2 echo '${banner}'\nsleep ${sleepSeconds}\n`,
    { mode: 0o755 },
  );
  return bin;
}

describe("the pinned release", () => {
  it("names one version and one sha256 for every computer wsp runs a connector on", () => {
    expect(Object.keys(CLOUDFLARED.assets).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm", "linux-arm64", "linux-x64"]);
    for (const [key, asset] of Object.entries(CLOUDFLARED.assets)) {
      expect(asset.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.url, key).toContain(`/download/${CLOUDFLARED.version}/`);
      expect(asset.url, key).toMatch(/^https:\/\/github\.com\/cloudflare\/cloudflared\//);
    }
    expect(pinnedCloudflared("linux", "x64").url).toContain("cloudflared-linux-amd64");
    expect(pinnedCloudflared("darwin", "arm64").archive).toBe("tgz");
  });

  it("refuses a computer the table has no binary for, naming the ones it has", () => {
    expect(() => pinnedCloudflared("win32", "x64")).toThrow(/win32-x64/);
    expect(() => pinnedCloudflared("win32", "x64")).toThrow(/linux-x64/);
  });

  it("writes the binary only once the sha256 matches, and leaves it runnable", async () => {
    const dir = tempDir("connector");
    const bytes = new TextEncoder().encode("#!/bin/sh\necho pinned\n");
    let fetched = 0;
    const bin = await fetchPinned(dir, pinFor(bytes), async () => {
      fetched += 1;
      return bytes;
    });
    expect(readFileSync(bin, "utf8")).toContain("pinned");
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    expect(await fetchPinned(dir, pinFor(bytes), async () => bytes)).toBe(bin);
    expect(fetched).toBe(1);
  });

  it("refuses bytes whose sha256 is not the pinned one, and keeps nothing", async () => {
    const dir = tempDir("connector");
    const pin = pinFor(new TextEncoder().encode("the release"));
    await expect(fetchPinned(dir, pin, async () => new TextEncoder().encode("something else"))).rejects.toThrow(/sha256/);
    await expect(fetchPinned(dir, pin, async () => new TextEncoder().encode("something else"))).rejects.toThrow(pin.url);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("unpacks the archive the mac release comes as", async () => {
    const made = tempDir("connector-src");
    writeFileSync(join(made, "cloudflared"), "#!/bin/sh\necho unpacked\n", { mode: 0o755 });
    expect(spawnSync("tar", ["-czf", join(made, "release.tgz"), "-C", made, "cloudflared"]).status).toBe(0);
    const bytes = new Uint8Array(readFileSync(join(made, "release.tgz")));

    const dir = tempDir("connector");
    const bin = await fetchPinned(dir, pinFor(bytes, { archive: "tgz" }), async () => bytes);
    expect(readFileSync(bin, "utf8")).toContain("unpacked");
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    expect(readdirSync(dir).some(name => name.endsWith(".tgz"))).toBe(false);
  });

  it("fetches what this computer runs from the table in the repo, and holds the answer to it", async () => {
    const dir = tempDir("connector");
    const asked: string[] = [];
    await expect(
      ensureCloudflared(dir, {
        platform: "linux",
        arch: "x64",
        fetchBytes: async url => {
          asked.push(url);
          return new TextEncoder().encode("not the release");
        },
      }),
    ).rejects.toThrow(/sha256/);
    expect(asked).toEqual([pinnedCloudflared("linux", "x64").url]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the connector child", () => {
  it("runs a managed tunnel and a quick one against the loopback port, with no credential in either line", () => {
    expect(connectorArgs({ token: "tok", port: 4400 })).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(connectorArgs({ port: 4400 })).toEqual(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4400"]);
  });

  it("hands the tunnel's credential to the child in its environment, where another user's ps cannot read it", async () => {
    const dir = tempDir("connector");
    const connector = startConnector({ bin: fakeConnector(dir, "INF starting"), stateDir: dir, port: 4400, token: "a-tunnel-token", log: () => {} });
    stops.push(() => connector.stop());
    await vi.waitUntil(() => existsSync(join(dir, "token")) && readFileSync(join(dir, "token"), "utf8").trim() !== "", { timeout: 4000 });
    expect(readFileSync(join(dir, "token"), "utf8").trim()).toBe("a-tunnel-token");
    expect(readFileSync(join(dir, "argv"), "utf8").trim()).toBe("tunnel --no-autoupdate run");
  });

  it("reads the hostname a quick tunnel printed and nothing else", () => {
    expect(quickHostname("2026-09-11T11:00:00Z INF |  https://blue-sky-1234.trycloudflare.com    |")).toBe("blue-sky-1234.trycloudflare.com");
    expect(quickHostname("INF Registered tunnel connection connIndex=0")).toBeUndefined();
  });

  it("hands the child the three things it needs and none of this computer's keys", async () => {
    const dir = tempDir("connector");
    const connector = startConnector({ bin: fakeConnector(dir, "INF starting"), stateDir: dir, port: 4400, token: "a-tunnel-token", log: () => {} });
    stops.push(() => connector.stop());
    // The script writes this file; waiting for it to exist would read it half written under a loaded machine.
    await vi.waitUntil(() => existsSync(join(dir, "env")) && readFileSync(join(dir, "env"), "utf8").includes("PATH="), { timeout: 4000 });
    const names = readFileSync(join(dir, "env"), "utf8")
      .split("\n")
      .filter(line => line.includes("="))
      .map(line => line.slice(0, line.indexOf("=")))
      .filter(name => name !== "PWD" && name !== "SHLVL" && name !== "_");
    expect(names.sort()).toEqual(["HOME", "PATH", "TUNNEL_TOKEN"]);
  });

  it("records the pid it started, hands over the hostname, and stops that pid alone", async () => {
    const dir = tempDir("connector");
    const seen: string[] = [];
    const connector = startConnector({
      bin: fakeConnector(dir, "INF |  https://blue-sky-1234.trycloudflare.com  |"),
      stateDir: dir,
      port: 4400,
      log: line => seen.push(line),
    });
    stops.push(() => connector.stop());
    const hostname = await connector.hostname();
    expect(hostname).toBe("blue-sky-1234.trycloudflare.com");
    expect(readFileSync(join(dir, "argv"), "utf8").trim()).toBe("tunnel --no-autoupdate --url http://127.0.0.1:4400");

    const pid = connector.pid!;
    const recorded = JSON.parse(readFileSync(join(dir, "connector.pid"), "utf8")) as { pid: number; startedAt: string };
    expect(recorded.pid).toBe(pid);
    expect(Date.parse(recorded.startedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(() => process.kill(pid, 0)).not.toThrow();

    await connector.stop();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(dir, "connector.pid"))).toBe(false);
  });

  it("leaves it gone when the caller says there is nothing left to carry", async () => {
    const dir = tempDir("connector");
    const bin = join(dir, "one-shot");
    writeFileSync(bin, `#!/bin/sh\necho run >> "${join(dir, "runs")}"\nexit 1\n`, { mode: 0o755 });
    const lines: string[] = [];
    const connector = startConnector({ bin, stateDir: dir, port: 4400, log: line => lines.push(line), restartMs: 20, keepRunning: () => false });
    stops.push(() => connector.stop());
    await vi.waitUntil(() => lines.length > 0, { timeout: 4000 });
    expect(lines.join("\n")).toContain("on no relay now");
    await new Promise(done => setTimeout(done, 120));
    expect(readFileSync(join(dir, "runs"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("starts it again when it goes, until it is stopped", async () => {
    const dir = tempDir("connector");
    const bin = join(dir, "one-shot");
    writeFileSync(bin, `#!/bin/sh\necho run >> "${join(dir, "runs")}"\nexit 1\n`, { mode: 0o755 });
    const lines: string[] = [];
    const connector = startConnector({ bin, stateDir: dir, port: 4400, log: line => lines.push(line), restartMs: 20 });
    stops.push(() => connector.stop());
    await vi.waitUntil(() => existsSync(join(dir, "runs")) && readFileSync(join(dir, "runs"), "utf8").split("\n").filter(Boolean).length >= 2, { timeout: 4000 });
    await connector.stop();
    const runs = readFileSync(join(dir, "runs"), "utf8").split("\n").filter(Boolean).length;
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(lines.join("\n")).toContain("connector");
    // Stopped means stopped: nothing starts after the stop returned.
    await new Promise(done => setTimeout(done, 100));
    expect(readFileSync(join(dir, "runs"), "utf8").split("\n").filter(Boolean).length).toBe(runs);
  });

  it("reads the name afresh at every start and hands over the ones that are new", async () => {
    const dir = tempDir("connector");
    const bin = join(dir, "renaming");
    const runs = join(dir, "runs");
    // cloudflared is handed a fresh quick tunnel name every time it runs, and there is nothing to stop it handing
    // out the same one twice; this stand-in repeats itself once before it moves on and stays up.
    writeFileSync(
      bin,
      `#!/bin/sh\nn=$(cat "${runs}" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "${runs}"\nif [ "$n" -ge 3 ]; then\n  >&2 echo 'INF |  https://next-name.trycloudflare.com  |'\n  sleep 30\nelse\n  >&2 echo 'INF |  https://same-name.trycloudflare.com  |'\n  exit 1\nfi\n`,
      { mode: 0o755 },
    );
    const names: string[] = [];
    const connector = startConnector({ bin, stateDir: dir, port: 4400, log: () => {}, restartMs: 20, onHostname: name => names.push(name) });
    stops.push(() => connector.stop());

    // The first name is still the one the hostname promise hands over, for the line printed at start.
    expect(await connector.hostname()).toBe("same-name.trycloudflare.com");
    await vi.waitUntil(() => names.length >= 2, { timeout: 4000 });
    expect(Number(readFileSync(runs, "utf8").trim())).toBe(3);
    // Three starts, two names: the start that repeated the name before it has nothing to report.
    expect(names).toEqual(["same-name.trycloudflare.com", "next-name.trycloudflare.com"]);
  });
});

describe("a connector another run left behind", () => {
  it("stops the pid that run wrote down", async () => {
    const dir = tempDir("connector");
    const connector = startConnector({ bin: fakeConnector(dir, "INF starting"), stateDir: dir, port: 4400, log: () => {} });
    const pid = await vi.waitUntil(() => connector.pid, { timeout: 4000 });
    await stopRecordedConnector(dir);
    expect(existsSync(join(dir, "connector.pid"))).toBe(false);
    expect(alive(pid)).toBe(false);
    await connector.stop();
  });

  it("leaves a pid from before this computer last started alone, whoever holds it now", async () => {
    const dir = tempDir("connector");
    const connector = startConnector({ bin: fakeConnector(dir, "INF starting"), stateDir: dir, port: 4400, log: () => {} });
    stops.push(() => connector.stop());
    const pid = await vi.waitUntil(() => connector.pid, { timeout: 4000 });
    // A record from before the last boot names a pid the system has since handed to somebody else.
    writeFileSync(join(dir, "connector.pid"), JSON.stringify({ pid, startedAt: "2020-01-01T00:00:00.000Z" }));

    await stopRecordedConnector(dir);
    expect(existsSync(join(dir, "connector.pid"))).toBe(false);
    expect(alive(pid)).toBe(true);
  });
});

/** Whether a pid is still there, as this test reads it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
