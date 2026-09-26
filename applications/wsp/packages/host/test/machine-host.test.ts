// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, Machine, TargetLogin } from "@wsp/engine";
import { afterEach, describe, expect, it } from "vitest";
import { MACHINE_READ_CAP, machineHost } from "../src/machine-host.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A road that runs each line in bash, keeping it, and may cut every answer at a byte count as a capped road does;
 * bytes land by the backend's own road. */
function bash(o: { cut?: number } = {}): { machine: Pick<Machine, "exec" | "id" | "putBytes" | "uploadUrl">; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    machine: {
      id: "m_bash",
      uploadUrl: () => Promise.reject(new Error("this backend mints no signed urls")),
      putBytes: (path, bytes) => Promise.resolve(writeFileSync(path, bytes)),
      exec: cmd => {
        lines.push(cmd);
        return new Promise<ExecResult>(resolve =>
          execFile("/bin/bash", ["-c", cmd], { maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => resolve({ exitCode: e === null ? 0 : 1, stdout: o.cut === undefined ? String(stdout) : String(stdout).slice(0, o.cut), stderr: "" })),
        );
      },
    },
  };
}

function home(): { dir: string; login: TargetLogin } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-mhost-"));
  roots.push(dir);
  return { dir, login: { platform: process.platform === "darwin" ? "darwin" : "linux", home: dir, path: "/usr/bin:/bin", user: "ada" } };
}

describe("the collector's Host over a machine", () => {
  it("answers the reads asked together from one command per kind, as the files stand", async () => {
    const { dir, login } = home();
    mkdirSync(join(dir, "d"));
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `f${i}.json`), `{"n": ${i}, "name": "it's ${i}"}`);
    const { machine, lines } = bash();
    const host = machineHost(machine, login, { land: machine });
    const files = Array.from({ length: 30 }, (_, i) => join(dir, `f${i}.json`));
    const [texts, stats, found, listed] = await Promise.all([
      Promise.all([...files, join(dir, "gone")].map(f => host.fs.readText(f))),
      Promise.all([join(dir, "d"), files[0]!, join(dir, "gone")].map(f => host.fs.stat(f))),
      Promise.all(["bash", "no-such-command-here"].map(b => host.exec.which(b))),
      host.fs.list(dir),
    ]);
    expect(lines).toHaveLength(4);
    expect(texts.slice(0, 30).map(t => JSON.parse(t!).n)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(texts[30]).toBeUndefined();
    expect(stats.map(s => s?.kind)).toEqual(["dir", "file", undefined]);
    expect(stats[1]!.bytes).toBe(Buffer.byteLength('{"n": 0, "name": "it\'s 0"}'));
    expect(found).toEqual([true, false]);
    expect(listed).toContain("d");
    expect(listed).toContain("f9.json");
    expect(host.refused).toEqual([]);
  });

  it("names a file over the cap and an answer the road cut short, rather than reading either as not there", async () => {
    const { dir, login } = home();
    writeFileSync(join(dir, "big.json"), "x".repeat(MACHINE_READ_CAP + 1));
    const road = bash().machine;
    const over = machineHost(road, login, { land: road });
    expect(await over.fs.readText(join(dir, "big.json"))).toBeUndefined();
    expect(over.refused).toEqual([`${join(dir, "big.json")} is over 1 MB and was not read`]);
    writeFileSync(join(dir, "a"), "a".repeat(4000));
    const short = bash({ cut: 100 }).machine;
    const cut = machineHost(short, login, { land: short });
    expect(await Promise.all([cut.fs.readText(join(dir, "a")), cut.fs.readText(join(dir, "a"))])).toEqual([undefined, undefined]);
    expect(cut.refused).toEqual([`read: the answer for ${join(dir, "a")} was cut short`]);
  });

  it("says why a road refused to run the reads at all, in the road's own first line, once", async () => {
    const { login } = home();
    const refusing: Pick<Machine, "exec"> = { exec: async () => ({ exitCode: 1, stdout: "", stderr: "runuser: user ada does not exist or the user entry does not contain all the required fields\n" }) };
    const host = machineHost(refusing, login, { stdin: true });
    expect(await Promise.all([host.fs.readText("/a"), host.fs.readText("/b")])).toEqual([undefined, undefined]);
    expect(await host.fs.readText("/c")).toBeUndefined();
    expect(host.refused).toEqual(["read: runuser: user ada does not exist or the user entry does not contain all the required fields"]);
  });

  it("runs a command word for word as the login, with the variables it is given, and answers nothing where it failed", async () => {
    const { login } = home();
    const { machine, lines } = bash();
    const host = machineHost(machine, login, { land: machine });
    expect(await host.exec.run("printf", ["%s|%s", "it's one word", "$HOME"], { env: { X: "y" } })).toBe("it's one word|$HOME");
    expect(await host.exec.run("sh", ["-c", 'printf %s "$X"'], { env: { X: "a b" } })).toBe("a b");
    expect(await host.exec.run("false", [])).toBeUndefined();
    // Names and values ride as data: a name that is shell is never run, and no value is on a line.
    const { dir, login: there } = home();
    const at = machineHost(machine, there, { land: machine });
    await at.exec.run("sh", ["-c", 'printf %s "$X"'], { env: { [`A=1; touch ${dir}/pwned; B`]: "x", X: "sk-x-value" } });
    expect(existsSync(join(dir, "pwned"))).toBe(false);
    for (const line of lines) expect(line).not.toContain("sk-x-value");
  });
});
