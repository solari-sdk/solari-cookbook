// SPDX-License-Identifier: AGPL-3.0-only
// The one write of an agent's config, run by this computer's own sh in a temp
// home: the file ends as it was or as the whole new text, a kill in the middle
// included, and the temp file a killed write leaves is swept by a later one.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configHardLinkRefusal } from "@wsp/protocol";
import { CONFIG_CHANGED_EXIT, CONFIG_LINKS_EXIT, CONFIG_LINK_EXIT, configLanding, configRefusal, configSum, configWriteLine, type ConfigWrite } from "../src/index.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function home(): string {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "wsp-config-write-")));
  homes.push(h);
  return h;
}

const sumOf = (file: string): string => configSum(readFileSync(file));

function write(w: Omit<ConfigWrite, "bytes">, text: string): { status: number | null; stdout: string } {
  const bytes = Buffer.from(text);
  const res = spawnSync("/bin/sh", ["-c", configWriteLine({ ...w, bytes: bytes.length })], { input: w.from === undefined ? bytes : undefined, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout };
}

const temps = (dir: string): string[] => readdirSync(dir).filter(n => n.startsWith(".wsp-config-"));

describe("configSum", () => {
  it("is what cksum prints for the same bytes", () => {
    for (const text of ["", "a", '{\n  "mcpServers": {}\n}\n', "é\u0000".repeat(3000)]) {
      const bytes = Buffer.from(text);
      expect(configSum(bytes), JSON.stringify(text.slice(0, 10))).toBe(execFileSync("cksum", { input: bytes, encoding: "utf8" }).trim().replace(/\s+/, " "));
    }
  });
});

describe("configWriteLine", () => {
  it("replaces the file whole by a rename from beside it, keeping its mode, and makes a new one 0600 with its folder", () => {
    const h = home();
    const file = join(h, ".claude.json");
    writeFileSync(file, "old\n");
    chmodSync(file, 0o640);
    expect(write({ file, base: h, sum: sumOf(file) }, "new\n").status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("new\n");
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(temps(h)).toEqual([]);

    const made = join(h, ".codex", "config.toml");
    expect(write({ file: made, base: h }, 'model = "x"\n').status).toBe(0);
    expect(readFileSync(made, "utf8")).toBe('model = "x"\n');
    expect(statSync(made).mode & 0o777).toBe(0o600);
  });

  it("writes through a link inside the base and leaves it a link, and refuses one out of it", () => {
    const h = home();
    mkdirSync(join(h, "dotfiles"));
    writeFileSync(join(h, "dotfiles", "settings.json"), "{}\n");
    const file = join(h, "settings.json");
    symlinkSync(join(h, "dotfiles", "settings.json"), file);
    expect(write({ file, base: h, sum: sumOf(file) }, '{ "a": 1 }\n').status).toBe(0);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(h, "dotfiles", "settings.json"), "utf8")).toBe('{ "a": 1 }\n');

    const out = home();
    writeFileSync(join(out, "x.json"), "{}\n");
    const linked = join(h, "out.json");
    symlinkSync(join(out, "x.json"), linked);
    const res = write({ file: linked, base: h, sum: sumOf(linked) }, "[]\n");
    expect(res.status).toBe(CONFIG_LINK_EXIT);
    expect(configRefusal({ exitCode: res.status!, stdout: res.stdout }, linked, p => p)).toBe(`${linked} is a link to ${join(out, "x.json")}, outside the folder it belongs to, so wsp does not write through it.`);
    expect(readFileSync(join(out, "x.json"), "utf8")).toBe("{}\n");
  });

  it("refuses a file with a second hard link, which a rename would split from it, and writes nothing", () => {
    const h = home();
    const file = join(h, "opencode.json");
    writeFileSync(file, "{}\n");
    linkSync(file, join(h, "twin.json"));
    const res = write({ file, base: h, sum: sumOf(file) }, '{ "mcp": {} }\n');
    expect(res.status).toBe(CONFIG_LINKS_EXIT);
    expect(configRefusal({ exitCode: res.status!, stdout: res.stdout }, file, () => "~/opencode.json")).toBe(configHardLinkRefusal("~/opencode.json"));
    expect(configHardLinkRefusal("~/opencode.json")).toContain("find / -xdev -samefile ~/opencode.json");
    expect(readFileSync(file, "utf8")).toBe("{}\n");
    expect(readFileSync(join(h, "twin.json"), "utf8")).toBe("{}\n");
    expect(temps(h)).toEqual([]);
  });

  it("writes nothing over a file that changed since the read, or one that appeared where there was none", () => {
    const h = home();
    const file = join(h, "config.toml");
    writeFileSync(file, "a\n");
    const sum = sumOf(file);
    writeFileSync(file, "b\n");
    expect(write({ file, base: h, sum }, "c\n").status).toBe(CONFIG_CHANGED_EXIT);
    expect(write({ file, base: h }, "c\n").status).toBe(CONFIG_CHANGED_EXIT);
    expect(readFileSync(file, "utf8")).toBe("b\n");
    expect(configRefusal({ exitCode: CONFIG_CHANGED_EXIT, stdout: "" }, file, () => "~/config.toml")).toBe("~/config.toml changed while wsp was writing it, so nothing was written; try again.");
    expect(temps(h)).toEqual([]);
  });

  it("takes the bytes from a landing beside the file and takes the landing with it", () => {
    const h = home();
    const file = join(h, "settings.json");
    const landing = configLanding(file, "0123456789ab");
    expect(landing).toBe(join(h, ".wsp-config-tmp.0123456789ab"));
    writeFileSync(landing, "landed\n");
    expect(write({ file, base: h, from: landing }, "landed\n").status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("landed\n");
    expect(existsSync(landing)).toBe(false);
  });

  it("leaves the old file whole when the write is killed partway, and a later write sweeps the temp file the killed one left", async () => {
    const h = home();
    const file = join(h, ".claude.json");
    const old = `${JSON.stringify({ keep: "x".repeat(1000) })}\n`;
    writeFileSync(file, old);
    const next = Buffer.from(`${JSON.stringify({ next: "y".repeat(200_000) })}\n`);
    const child = spawn("/bin/sh", ["-c", configWriteLine({ file, base: h, sum: sumOf(file), bytes: next.length })], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    const gone = new Promise(done => child.on("close", done));
    child.stdin.write(next.subarray(0, next.length / 2));
    for (let i = 0; i < 200 && !temps(h).some(n => statSync(join(h, n)).size > old.length); i++) await new Promise(r => setTimeout(r, 25));
    process.kill(-child.pid!, "SIGKILL");
    await gone;
    expect(readFileSync(file, "utf8")).toBe(old);
    const left = temps(h);
    expect(left).toHaveLength(1);

    // A temp file of a write still running is young, and stays; the killed one's is aged past the sweep's age.
    writeFileSync(join(h, ".wsp-config-tmp.Young1"), "");
    const aged = new Date(Date.now() - 11 * 60_000);
    utimesSync(join(h, left[0]!), aged, aged);
    expect(write({ file, base: h, sum: sumOf(file) }, "whole\n").status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("whole\n");
    expect(temps(h)).toEqual([".wsp-config-tmp.Young1"]);
  });

  it("sweeps only the two temp shapes it mints, so a person's file of a like name in the home survives however old", () => {
    const h = home();
    const file = join(h, ".claude.json");
    writeFileSync(file, "{}\n");
    const aged = new Date(Date.now() - 60 * 60_000);
    const theirs = [".wsp-config-notes.md", ".wsp-config-tmp.notes.md", ".wsp-config-tmp.abc12", ".wsp-config-tmp.0123456789abc", ".wsp-config-tmp.0123456789aZ"];
    const ours = [".wsp-config-tmp.aB3xY9", ".wsp-config-tmp.0123456789ab"];
    for (const n of [...theirs, ...ours]) {
      writeFileSync(join(h, n), "kept");
      utimesSync(join(h, n), aged, aged);
    }
    expect(write({ file, base: h, sum: sumOf(file) }, "[]\n").status).toBe(0);
    expect(temps(h).sort()).toEqual([...theirs].sort());
  });

  it("names a link whose path holds a tab or a newline whole in its refusal", () => {
    const h = home();
    const out = home();
    const target = join(out, "a\tb\nc.json");
    writeFileSync(target, "{}\n");
    const linked = join(h, "x\ty\nz.json");
    symlinkSync(target, linked);
    const res = write({ file: linked, base: h, sum: sumOf(linked) }, "[]\n");
    expect(res.status).toBe(CONFIG_LINK_EXIT);
    expect(configRefusal({ exitCode: res.status!, stdout: res.stdout }, linked, p => p)).toBe(`${linked} is a link to ${target}, outside the folder it belongs to, so wsp does not write through it.`);
  });

  it("writes nothing when fewer bytes came than were promised", () => {
    const h = home();
    const file = join(h, "settings.json");
    writeFileSync(file, "old\n");
    const res = spawnSync("/bin/sh", ["-c", configWriteLine({ file, base: h, sum: sumOf(file), bytes: 100 })], { input: "cut\n" });
    expect(res.status).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("old\n");
    expect(temps(h)).toEqual([]);
  });
});
