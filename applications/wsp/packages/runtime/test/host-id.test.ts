// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostIdentity, localConfigDir, templateHost } from "../src/host-id.js";
import { withRefused } from "./fs-refusal.js";

vi.mock("node:fs", async importOriginal => (await import("./fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

describe("templateHost", () => {
  it("is the per-install hex id alone, never the hostname, so a provider name field gets lowercase letters and digits only", () => {
    expect(templateHost("zingzys-MacBook-Pro.local:9f3a1c2b")).toBe("9f3a1c2b");
    expect(templateHost("dev.box:00ff00ff")).toBe("00ff00ff");
  });

  it("an identity that fell back to the bare hostname is reduced to the same character class", () => {
    expect(templateHost("zingzys-MacBook-Pro.local")).toBe("zingzysmacbookprolocal");
    expect(templateHost("zingzys-MacBook-Pro.local")).toMatch(/^[a-z0-9]+$/);
  });
});

describe("host identity", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("is the hostname plus a per-install id made once in the given dir and read back after", () => {
    const parent = mkdtempSync(join(tmpdir(), "wsp-host-id-"));
    dirs.push(parent);
    const dir = join(parent, "wsp");
    const first = hostIdentity(dir);
    expect(first.startsWith(`${hostname()}:`)).toBe(true);
    expect(first.slice(hostname().length + 1)).toMatch(/^[0-9a-f]{8}$/);
    expect(existsSync(join(dir, "host-id"))).toBe(true);
    expect(hostIdentity(dir)).toBe(first);
    expect(readFileSync(join(dir, "host-id"), "utf8").trim()).toBe(first.slice(hostname().length + 1));
  });

  it("a second read writes nothing over the id it finds: the same bytes and the same mtime", async () => {
    // Every start of a host on this computer reads the install id through this one function, so this is what a
    // person's home sees on the second start: a fresh install writes the nine bytes once and nothing touches them
    // after. The file lives outside every wsp home on purpose, being the thing two machines over one state file
    // tell each other apart by.
    const parent = mkdtempSync(join(tmpdir(), "wsp-host-id-once-"));
    dirs.push(parent);
    const dir = join(parent, "wsp");
    const path = join(dir, "host-id");
    const first = hostIdentity(dir);
    const made = readFileSync(path, "utf8");
    expect(made).toMatch(/^[0-9a-f]{8}\n$/);
    const before = statSync(path);
    // A whole millisecond apart, so an mtime that did move is one this case can see.
    await new Promise(r => setTimeout(r, 20));
    expect(hostIdentity(dir)).toBe(first);
    const after = statSync(path);
    expect(readFileSync(path, "utf8")).toBe(made);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
  });

  it("the id and the folder it sits in are this user's alone, whatever the umask", () => {
    const parent = mkdtempSync(join(tmpdir(), "wsp-host-id-mode-"));
    dirs.push(parent);
    const dir = join(parent, "wsp");
    hostIdentity(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "host-id")).mode & 0o777).toBe(0o600);
  });

  it("the suite's default dir is the temp XDG_CONFIG_HOME, so no test reaches the developer's real config dir", () => {
    const xdg = process.env["XDG_CONFIG_HOME"];
    expect(xdg).toBeDefined();
    expect(xdg!.startsWith(tmpdir())).toBe(true);
    expect(localConfigDir()).toBe(join(xdg!, "wsp"));
  });

  it("falls back to the hostname alone when the dir cannot be made, and says so once", async () => {
    const parent = mkdtempSync(join(tmpdir(), "wsp-host-id-ro-"));
    dirs.push(parent);
    const dir = join(parent, "wsp");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withRefused(dir, () => {
        expect(hostIdentity(dir)).toBe(hostname());
        expect(hostIdentity(dir)).toBe(hostname());
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/^host id not kept in .*; holds carry the hostname alone$/);
      expect(existsSync(dir)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
