import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getDefaultHighWaterMark } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { UPLOAD_PART_BYTES, exportFolder, exportPaths, exportPathsInto, fitsTar, folderExportScript, importInto, landBundle, tarOf, type CacheRule } from "../src/vault.js";
import type { ExecResult, Machine } from "../src/machine.js";
import { tarRead } from "./tar-read.js";

const TAR_BYTES = Buffer.from("fake-tgz-bytes-" + "x".repeat(64));

function vaultStub() {
  const execCmds: string[] = [];
  const runs: string[] = [];
  const guestFiles = new Map<string, Buffer>();
  const machine: Machine = {
    id: "mv", kind: "sandbox", streamUrl: undefined,
    exec: async (cmd): Promise<ExecResult> => {
      execCmds.push(cmd);
      const tarCreate = cmd.match(/^tar czf '([^']+)'/);
      if (tarCreate) guestFiles.set(tarCreate[1]!, TAR_BYTES);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    run: script => {
      runs.push(script);
      return machine.exec(script);
    },
    snapshot: async () => "snap", pause: async () => {}, resume: async () => {},
    kill: async () => {}, state: async () => "running" as const,
    downloadUrl: async (p) => `https://signed.example/dl?path=${encodeURIComponent(p)}`,
    uploadUrl: async (p) => `https://signed.example/ul?path=${encodeURIComponent(p)}`,
  };
  const puts: { url: string; body: Buffer }[] = [];
  const fetchStub = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "PUT") {
      puts.push({ url: u, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: 200 });
    }
    const path = decodeURIComponent(new URL(u).searchParams.get("path") ?? "");
    const bytes = guestFiles.get(path);
    if (!bytes) return new Response("no such guest file", { status: 404 });
    return new Response(new Uint8Array(bytes), { status: 200 });
  });
  return { machine, execCmds, runs, puts, fetchStub };
}

describe("vault", () => {
  it("exportPaths tars the paths in the guest and returns the bytes", async () => {
    const { machine, execCmds, fetchStub } = vaultStub();
    const buf = await exportPaths(machine, ["/root/.claude-cfg"], { fetch: fetchStub });
    expect(buf.equals(TAR_BYTES)).toBe(true);
    const tarCmd = execCmds.find(c => c.startsWith("tar czf"));
    expect(tarCmd).toMatch(/-C '\/' 'root\/.claude-cfg'/);
    expect(execCmds.some(c => c.startsWith("rm -f"))).toBe(true); // guest temp cleaned
  });

  it("the tar and the untar run detached; the size read and the cleanup stay inline", async () => {
    const { machine, execCmds, runs, fetchStub } = vaultStub();
    await exportPaths(machine, ["/root/.zshrc"], { fetch: fetchStub, maxBytes: 1_000_000 });
    await importInto(machine, TAR_BYTES, "/root", { fetch: fetchStub });
    expect(runs.map(r => r.split("\n")[0]!.split(" ").slice(0, 2).join(" "))).toEqual(["tar czf", "set -eo"]);
    expect(runs[1]).toContain("tar xzf");
    const inline = execCmds.filter(c => !runs.includes(c));
    expect(inline.map(c => c.split(" ").slice(0, 2).join(" "))).toEqual(["wc -c", "rm -f"]);
  });

  it("importInto uploads via uploadUrl and untars at the destination", async () => {
    const { machine, execCmds, puts, fetchStub } = vaultStub();
    const payload = Buffer.from("payload-tgz");
    await importInto(machine, payload, "/root", { fetch: fetchStub });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body.equals(payload)).toBe(true);
    const untar = execCmds.find(c => c.includes("tar xzf"));
    expect(untar).toMatch(/-C '\/root'/);
  });

  it("an overlay import merges into the destination: no recursive unlink, files owned by the guest user", async () => {
    const { machine, execCmds, fetchStub } = vaultStub();
    await importInto(machine, Buffer.from("payload-tgz"), "/root", { fetch: fetchStub, overlay: true });
    const untar = execCmds.find(c => c.includes("tar xzf"))!;
    expect(untar).toMatch(/-C '\/root' --no-same-owner/);
    expect(untar).not.toContain("--recursive-unlink");
  });

  it("surfaces a failing tar instead of returning garbage", async () => {
    const { machine, fetchStub } = vaultStub();
    machine.exec = async () => ({ exitCode: 2, stdout: "", stderr: "tar: /root/nope: No such file" });
    await expect(exportPaths(machine, ["/root/nope"], { fetch: fetchStub })).rejects.toThrow(/tar/);
  });
});

describe("vault size cap", () => {
  it("exportPaths refuses an archive over maxBytes before downloading it, and removes it", async () => {
    const { machine, execCmds, fetchStub } = vaultStub();
    const sized: Machine = {
      ...machine,
      exec: async cmd => {
        if (/^wc -c </.test(cmd)) return { exitCode: 0, stdout: "300000000\n", stderr: "" };
        return machine.exec(cmd);
      },
    };
    await expect(exportPaths(sized, ["/root/big"], { fetch: fetchStub, maxBytes: 200_000_000 })).rejects.toMatchObject({
      kind: "vaultTooLarge",
      bytes: 300_000_000,
      message: "the export was 286 MB, over the 191 MB cap",
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(execCmds.some(c => c.startsWith("rm -f"))).toBe(true);
  });
});

describe("vault import in parts", () => {
  const MIB = 1024 * 1024;
  const CAP = 32 * MIB;
  const REFUSAL = JSON.stringify({ error: "Payload Too Large", limit: CAP });
  const dirs: string[] = [];
  const guestFiles: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const p of guestFiles.splice(0)) rmSync(p, { force: true });
  });

  /** This computer stands in for the guest: uploads land at the path the URL names and exec runs the
   * script under bash, so the reassembly, the hash check and the extraction are the real commands. */
  /** `drop` names a part the server acknowledges but never writes, the shape of a part lost on the guest. */
  async function guest(corrupt = false, drop?: string) {
    const puts: { path: string; bytes: number }[] = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url!, "http://x").searchParams.get("path")!;
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        puts.push({ path, bytes: body.length });
        if (body.length > CAP) {
          res.writeHead(413, { "content-type": "application/json" }).end(REFUSAL);
          return;
        }
        const mid = Math.floor(body.length / 2);
        if (corrupt) body.writeUInt8(body.readUInt8(mid) ^ 0xff, mid);
        if (!path.endsWith(drop ?? "\0")) {
          guestFiles.push(path);
          writeFileSync(path, body);
        }
        res.writeHead(200).end(JSON.stringify({ ok: true, path, bytes: body.length }));
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    server.unref();
    const port = (server.address() as AddressInfo).port;
    const execCmds: string[] = [];
    const machine: Machine = {
      id: "mv", kind: "sandbox", streamUrl: undefined,
      exec: cmd => {
        execCmds.push(cmd);
        return new Promise<ExecResult>(resolve => {
          execFile("bash", ["-c", cmd], { maxBuffer: 16 * MIB }, (err, stdout, stderr) => {
            resolve({ exitCode: err === null ? 0 : ((err as { code?: number }).code ?? 1), stdout, stderr });
          });
        });
      },
      run: script => machine.exec(script),
      snapshot: async () => "snap", pause: async () => {}, resume: async () => {},
      kill: async () => {}, state: async () => "running" as const,
      downloadUrl: async p => `http://127.0.0.1:${port}/download?path=${encodeURIComponent(p)}`,
      uploadUrl: async p => `http://127.0.0.1:${port}/upload?path=${encodeURIComponent(p)}`,
    };
    return { machine, puts, execCmds, close: () => server.close() };
  }

  function tarOf(bytes: Buffer): Promise<Buffer> {
    const src = mkdtempSync(join(tmpdir(), "wsp-vault-src-"));
    dirs.push(src);
    writeFileSync(join(src, "blob.bin"), bytes);
    const tgz = join(src, "..", `${basename(src)}.tgz`);
    return new Promise((resolve, reject) => {
      execFile("tar", ["-czf", tgz, "-C", src, "blob.bin"], err => {
        if (err) reject(err);
        else {
          const out = readFileSync(tgz);
          rmSync(tgz, { force: true });
          resolve(out);
        }
      });
    });
  }

  /** A valid gzip of exactly `target` bytes: the tar of `blob` deflated at level 0 (stored blocks, so random
   * bytes do not grow), then padded to the length through a gzip comment field, which every reader skips. */
  function gzipOfExactLength(blob: Buffer, target: number): Buffer {
    const src = mkdtempSync(join(tmpdir(), "wsp-vault-src-"));
    dirs.push(src);
    writeFileSync(join(src, "blob.bin"), blob);
    const tarPath = join(src, "..", `${basename(src)}.tar`);
    execFileSync("tar", ["-cf", tarPath, "-C", src, "blob.bin"]);
    const gz = gzipSync(readFileSync(tarPath), { level: 0 });
    rmSync(tarPath, { force: true });
    const pad = target - gz.length;
    if (pad < 1) throw new Error(`archive already ${gz.length} bytes, over the ${target} asked`);
    const header = Buffer.from(gz.subarray(0, 10));
    header[3] = header[3]! | 0x10;
    return Buffer.concat([header, Buffer.alloc(pad - 1, 0x61), Buffer.from([0]), gz.subarray(10)]);
  }

  async function landsIdentical(tar: Buffer, blob: Buffer) {
    const g = await guest();
    const dest = mkdtempSync(join(tmpdir(), "wsp-vault-dest-"));
    dirs.push(dest);
    try {
      const out = await importInto(g.machine, tar, dest, { fetch: globalThis.fetch, overlay: true });
      expect(readFileSync(join(dest, "blob.bin")).equals(blob)).toBe(true);
      for (const p of g.puts) expect(existsSync(p.path)).toBe(false);
      return { out, puts: g.puts };
    } finally {
      g.close();
    }
  }

  it("an archive of exactly one part goes up as one PUT under the plain name; one byte more is a second part of one byte", async () => {
    const blob = randomBytes(UPLOAD_PART_BYTES - 20_000);
    const exact = gzipOfExactLength(blob, UPLOAD_PART_BYTES);
    expect(exact.length).toBe(UPLOAD_PART_BYTES);
    const one = await landsIdentical(exact, blob);
    expect(one.out.parts).toBe(1);
    expect(one.puts.map(p => [p.bytes, p.path.endsWith(".tgz")])).toEqual([[UPLOAD_PART_BYTES, true]]);

    const over = gzipOfExactLength(blob, UPLOAD_PART_BYTES + 1);
    const two = await landsIdentical(over, blob);
    expect(two.out.parts).toBe(2);
    expect(two.puts.map(p => [p.bytes, p.path.slice(-6)])).toEqual([[UPLOAD_PART_BYTES, ".part0"], [1, ".part1"]]);
  }, 120_000);

  it("an empty archive is refused before any upload", async () => {
    const { machine, execCmds } = vaultStub();
    const fetchStub = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(importInto(machine, Buffer.alloc(0), "/root", { fetch: fetchStub })).rejects.toThrow(/empty archive/);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(execCmds).toEqual([]);
  });

  it("reports each part as it lands", async () => {
    const { machine, fetchStub } = vaultStub();
    const seen: unknown[] = [];
    const tar = Buffer.alloc(UPLOAD_PART_BYTES + 5);
    await importInto(machine, tar, "/root", { fetch: fetchStub, onPart: p => void seen.push(p) });
    expect(seen).toEqual([
      { part: 1, parts: 2, bytes: UPLOAD_PART_BYTES, total: tar.length },
      { part: 2, parts: 2, bytes: tar.length, total: tar.length },
    ]);
  });

  it("says how many pieces a part was cut into on a road that cuts them, and nothing on one that takes it whole", async () => {
    const { machine, fetchStub } = vaultStub();
    const seen: unknown[] = [];
    const tar = Buffer.from("a small archive");
    const byRoad: Machine = { ...machine, putBytes: async () => ({ pieces: 7 }) };
    await importInto(byRoad, tar, "/root", { fetch: fetchStub, onPart: p => void seen.push(p) });
    expect(seen).toEqual([{ part: 1, parts: 1, bytes: tar.length, total: tar.length, pieces: 7 }]);
    // The signed URL road puts the part in one call, so there is no piece count to carry.
    seen.length = 0;
    await importInto(machine, tar, "/root", { fetch: fetchStub, onPart: p => void seen.push(p) });
    expect(seen).toEqual([{ part: 1, parts: 1, bytes: tar.length, total: tar.length }]);
  });

  it("a part the edge answers 502 or drops is retried with a bound; the retry is per part and the parts already up are not sent again", async () => {
    const { machine, fetchStub } = vaultStub();
    const answers = [200, 502, "drop", 200];
    const sent: number[] = [];
    const flaky: typeof fetch = async (url, init) => {
      const a = answers.shift();
      sent.push((init?.body as Uint8Array).length);
      if (a === "drop") throw new TypeError("fetch failed");
      if (a !== 200) return new Response(JSON.stringify({ error: "Bad Gateway" }), { status: a as number });
      return fetchStub(url, init);
    };
    const out = await importInto(machine, Buffer.alloc(UPLOAD_PART_BYTES + 7), "/root", { fetch: flaky });
    expect(out.parts).toBe(2);
    expect(sent).toEqual([UPLOAD_PART_BYTES, 7, 7, 7]);
  }, 20_000);

  it("a part that keeps failing gives up after three attempts, naming the part, the status, the body and the attempts, and removes every part path", async () => {
    const { machine, execCmds } = vaultStub();
    let n = 0;
    const down: typeof fetch = async () => {
      n++;
      return new Response(JSON.stringify({ error: "Service Unavailable" }), { status: 503 });
    };
    await expect(importInto(machine, Buffer.alloc(UPLOAD_PART_BYTES + 7), "/root", { fetch: down })).rejects.toThrow(/part 1 of 2: HTTP 503 Service Unavailable after 3 attempts/);
    expect(n).toBe(3);
    expect(execCmds.some(c => c.startsWith("rm -f") && c.includes(".part0") && c.includes(".part1"))).toBe(true);
  }, 20_000);

  it("a 40 MB archive goes up in two parts under the measured cap and lands byte-identical", async () => {
    const blob = randomBytes(40 * MIB);
    const tar = await tarOf(blob);
    expect(tar.length).toBeGreaterThan(CAP);
    const g = await guest();
    const dest = mkdtempSync(join(tmpdir(), "wsp-vault-dest-"));
    dirs.push(dest);
    try {
      const out = await importInto(g.machine, tar, dest, { fetch: globalThis.fetch, overlay: true });
      expect(out.parts).toBe(2);
      expect(g.puts.map(p => p.bytes)).toEqual([CAP, tar.length - CAP]);
      expect(readFileSync(join(dest, "blob.bin")).equals(blob)).toBe(true);
      for (const p of g.puts) expect(existsSync(p.path)).toBe(false);
    } finally {
      g.close();
    }
  }, 60_000);

  it("a part the provider refuses names the limit it answered with, and the parts already up are removed", async () => {
    const { machine, execCmds } = vaultStub();
    let n = 0;
    const fetchStub: typeof fetch = async () => (++n === 1 ? new Response(null, { status: 200 }) : new Response(REFUSAL, { status: 413, statusText: "Payload Too Large" }));
    await expect(importInto(machine, Buffer.alloc(33 * MIB), "/root", { fetch: fetchStub })).rejects.toThrow(/part 2 of 2.*HTTP 413.*33554432 bytes/);
    expect(n).toBe(2);
    expect(execCmds.some(c => c.startsWith("rm -f") && c.includes(".part0"))).toBe(true);
    expect(execCmds.some(c => c.includes("tar xzf"))).toBe(false);
  });

  it("a part missing on the machine is reported as cat's error, not as a hash mismatch, and the other parts are removed", async () => {
    const tar = await tarOf(randomBytes(33 * MIB));
    const g = await guest(false, ".part1");
    const dest = mkdtempSync(join(tmpdir(), "wsp-vault-dest-"));
    dirs.push(dest);
    try {
      const err = await importInto(g.machine, tar, dest, { fetch: globalThis.fetch, overlay: true }).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/vault import untar failed.*No such file or directory/);
      expect((err as Error).message).not.toMatch(/did not match its hash/);
      expect(existsSync(join(dest, "blob.bin"))).toBe(false);
      for (const p of g.puts) expect(existsSync(p.path)).toBe(false);
    } finally {
      g.close();
    }
  }, 60_000);

  it("a failed extraction leaves no part behind on the machine", async () => {
    const notATar = randomBytes(33 * MIB);
    const g = await guest();
    const dest = mkdtempSync(join(tmpdir(), "wsp-vault-dest-"));
    dirs.push(dest);
    try {
      await expect(importInto(g.machine, notATar, dest, { fetch: globalThis.fetch, overlay: true })).rejects.toThrow(/vault import untar failed/);
      expect(g.puts).toHaveLength(2);
      for (const p of g.puts) expect(existsSync(p.path)).toBe(false);
    } finally {
      g.close();
    }
  }, 60_000);

  it("an archive that does not match its hash after reassembly is refused before anything is extracted", async () => {
    const tar = await tarOf(randomBytes(4096));
    const g = await guest(true);
    const dest = mkdtempSync(join(tmpdir(), "wsp-vault-dest-"));
    dirs.push(dest);
    try {
      await expect(importInto(g.machine, tar, dest, { fetch: globalThis.fetch, overlay: true })).rejects.toThrow(/did not match its hash/);
      expect(existsSync(join(dest, "blob.bin"))).toBe(false);
      for (const p of g.puts) expect(existsSync(p.path)).toBe(false);
    } finally {
      g.close();
    }
  });
});

describe("landBundle", () => {
  const dirs: string[] = [];
  const guestFiles: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const p of guestFiles.splice(0)) rmSync(p, { force: true });
  });

  /** This computer stands in for the guest, as in the parts tests: uploads land where the URL says and bash runs the scripts. */
  async function guest() {
    const puts: string[] = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url!, "http://x").searchParams.get("path")!;
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c as Buffer));
      req.on("end", () => {
        puts.push(path);
        guestFiles.push(path);
        writeFileSync(path, Buffer.concat(chunks));
        res.writeHead(200).end();
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    server.unref();
    const port = (server.address() as AddressInfo).port;
    const machine: Machine = {
      id: "mv", kind: "sandbox", streamUrl: undefined,
      exec: cmd =>
        new Promise<ExecResult>(resolve => {
          execFile("bash", ["-c", cmd], (err, stdout, stderr) => {
            resolve({ exitCode: err === null ? 0 : ((err as { code?: number }).code ?? 1), stdout, stderr });
          });
        }),
      run: script => machine.exec(script),
      snapshot: async () => "snap", pause: async () => {}, resume: async () => {},
      kill: async () => {}, state: async () => "running" as const,
      downloadUrl: async p => `http://127.0.0.1:${port}/download?path=${encodeURIComponent(p)}`,
      uploadUrl: async p => `http://127.0.0.1:${port}/upload?path=${encodeURIComponent(p)}`,
    };
    return { machine, puts, close: () => server.close() };
  }

  const binary = Buffer.concat([Buffer.from("#!/bin/sh\necho hi\n"), randomBytes(3000), Buffer.from([0, 0xff, 0x0a])]);
  const bundle = () =>
    tarOf([
      { path: "src", mode: 0o755, dir: true },
      { path: "src/run.sh", mode: 0o755, content: binary },
      { path: "src/plain.txt", mode: 0o644, content: "plain\n" },
    ]);

  it("lands the archive at the path, parents made, with the bytes, the exec bit and the stages in order, and leaves no staging directory", async () => {
    const g = await guest();
    const root = mkdtempSync(join(tmpdir(), "wsp-land-"));
    dirs.push(root);
    const dest = join(root, "work", "proj");
    const stages: string[] = [];
    try {
      const out = await landBundle(g.machine, bundle(), dest, { onPart: () => stages.push("part"), onLanding: () => stages.push("landing") });
      expect(out.parts).toBe(1);
      expect(stages).toEqual(["part", "landing"]);
      expect(readFileSync(join(dest, "src/run.sh")).equals(binary)).toBe(true);
      expect(statSync(join(dest, "src/run.sh")).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(dest, "src/plain.txt"), "utf8")).toBe("plain\n");
      expect(readdirSync(join(root, "work"))).toEqual(["proj"]);
      for (const p of g.puts) expect(existsSync(p)).toBe(false);
    } finally {
      g.close();
    }
  });

  it("refuses an existing destination with kind exists before any byte goes up, and replaces it when told to", async () => {
    const g = await guest();
    const root = mkdtempSync(join(tmpdir(), "wsp-land-"));
    dirs.push(root);
    const dest = join(root, "proj");
    mkdirSync(dest);
    writeFileSync(join(dest, "old.txt"), "old\n");
    try {
      await expect(landBundle(g.machine, bundle(), dest)).rejects.toMatchObject({ kind: "exists", message: expect.stringContaining("import with replace") });
      expect(g.puts).toEqual([]);
      expect(readFileSync(join(dest, "old.txt"), "utf8")).toBe("old\n");
      await landBundle(g.machine, bundle(), dest, { replace: true });
      expect(existsSync(join(dest, "old.txt"))).toBe(false);
      expect(readFileSync(join(dest, "src/plain.txt"), "utf8")).toBe("plain\n");
      expect(readdirSync(root)).toEqual(["proj"]);
    } finally {
      g.close();
    }
  });

  it("refuses a relative destination and the root", async () => {
    const { machine } = vaultStub();
    await expect(landBundle(machine, bundle(), "work/proj")).rejects.toThrow(/absolute path/);
    await expect(landBundle(machine, bundle(), "/")).rejects.toThrow(/absolute path/);
    await expect(landBundle(machine, bundle(), "//")).rejects.toThrow(/absolute path/);
  });
});

describe("tarOf", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const extract = (tgz: Buffer): string => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-tarof-"));
    dirs.push(dir);
    tarRead(["-xzf", "-", "-C", dir], tgz);
    return dir;
  };

  it("packs each text at its path with its mode, so a plain tar lands them where the upload road extracts", () => {
    const deep = `etc/${"a".repeat(60)}/${"b".repeat(60)}/${"c".repeat(40)}.md`;
    const tgz = tarOf([
      { path: "/etc/wsp/machine-context.md", mode: 0o644, content: "short text\n" },
      { path: "/root/.hermes/skills/wsp-machine/SKILL.md", mode: 0o600, content: "skill\n" },
      { path: `/${deep}`, mode: 0o644, content: "deep\n" },
      { path: "/etc/wsp/empty", mode: 0o644, content: "" },
    ]);
    const dir = extract(tgz);
    expect(tarRead(["-tzf", "-"], tgz).toString().trim().split("\n")).toEqual(["etc/wsp/machine-context.md", "root/.hermes/skills/wsp-machine/SKILL.md", deep, "etc/wsp/empty"]);
    expect(readFileSync(join(dir, "etc/wsp/machine-context.md"), "utf8")).toBe("short text\n");
    expect(readFileSync(join(dir, "root/.hermes/skills/wsp-machine/SKILL.md"), "utf8")).toBe("skill\n");
    expect(readFileSync(join(dir, deep), "utf8")).toBe("deep\n");
    expect(readFileSync(join(dir, "etc/wsp/empty"), "utf8")).toBe("");
    expect(statSync(join(dir, "etc/wsp/machine-context.md")).mode & 0o777).toBe(0o644);
    expect(statSync(join(dir, "root/.hermes/skills/wsp-machine/SKILL.md")).mode & 0o777).toBe(0o600);
  });

  it("refuses a path a ustar header cannot hold", () => {
    expect(() => tarOf([{ path: `/${"x".repeat(120)}`, mode: 0o644, content: "" }])).toThrow(/ustar/);
    expect(fitsTar(`/${"x".repeat(120)}`)).toBe(false);
    expect(fitsTar("a/b.txt")).toBe(true);
    expect(fitsTar("a/link", "t".repeat(101))).toBe(false);
  });

  it("carries bytes as they are, a directory of its own, a symlink as a link and the exec bit", () => {
    const tail = Buffer.concat([Buffer.from("text then binary\n"), randomBytes(1500), Buffer.from([0x00, 0xff, 0xfe])]);
    const tgz = tarOf([
      { path: "proj", mode: 0o750, dir: true },
      { path: "proj/empty", mode: 0o755, dir: true },
      { path: "proj/bin/run", mode: 0o755, content: tail },
      { path: "proj/link", target: "bin/run" },
    ]);
    const dir = extract(tgz);
    expect(readFileSync(join(dir, "proj/bin/run")).equals(tail)).toBe(true);
    expect(statSync(join(dir, "proj/bin/run")).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, "proj/empty")).isDirectory()).toBe(true);
    expect(statSync(join(dir, "proj/empty")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(dir, "proj/link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "proj/link"))).toBe("bin/run");
  });
});

describe("exportFolder", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const RULE: CacheRule = { dirs: ["node_modules", "dist", ".cache"], files: [".DS_Store"], markers: ["pyvenv.cfg"] };

  /** A folder with source, ignored state, a repository and every cache shape the rule names. */
  function folder(): string {
    const root = mkdtempSync(join(tmpdir(), "wsp-export-src-"));
    dirs.push(root);
    const put = (rel: string, text: string): void => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put("src/a.ts", "a\n");
    put("src/cache-utils.ts", "a source file whose name holds the word\n");
    put(".env", "TOKEN=x\n");
    put(".git/config", "[core]\n");
    put(".git/build/keep", "nothing under .git is judged\n");
    put("node_modules/left/index.js", "cache\n");
    put("dist/out.js", "output\n");
    put(".cache/x", "cache\n");
    put("notes/CacheNotes.md", "the word, any case, still not a cache\n");
    put("my-cache-service/README.md", "a directory whose name holds the word\n");
    put("src/dist", "a file named like a cache directory\n");
    put(".DS_Store", "finder");
    put("myenv/pyvenv.cfg", "home = /usr/bin\n");
    put("myenv/bin/python", "venv by marker\n");
    put("deep/dir/.DS_Store", "finder");
    mkdirSync(join(root, "really-empty"));
    return root;
  }

  /** This computer stands in for the guest: bash runs the script and the download serves the file the URL names.
   * With chunkBytes the body arrives in writes of that size a tick apart, the way an archive off a real machine does. */
  async function guest(chunkBytes?: number) {
    const server = createServer((req, res) => {
      const path = new URL(req.url!, "http://x").searchParams.get("path")!;
      if (!existsSync(path)) {
        res.writeHead(404).end();
        return;
      }
      const body = readFileSync(path);
      res.writeHead(200, { "content-length": String(body.length) });
      if (chunkBytes === undefined) {
        res.end(body);
        return;
      }
      let at = 0;
      const write = (): void => {
        if (at >= body.length) {
          res.end();
          return;
        }
        res.write(body.subarray(at, at + chunkBytes));
        at += chunkBytes;
        setTimeout(write, 1);
      };
      write();
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    server.unref();
    const port = (server.address() as AddressInfo).port;
    const cmds: string[] = [];
    const machine: Machine = {
      id: "mv", kind: "sandbox", streamUrl: undefined,
      exec: cmd => {
        cmds.push(cmd);
        return new Promise<ExecResult>(resolve => {
          execFile("bash", ["-c", cmd], (err, stdout, stderr) => {
            resolve({ exitCode: err === null ? 0 : ((err as { code?: number }).code ?? 1), stdout, stderr });
          });
        });
      },
      run: script => machine.exec(script),
      snapshot: async () => "snap", pause: async () => {}, resume: async () => {},
      kill: async () => {}, state: async () => "running" as const,
      downloadUrl: async p => `http://127.0.0.1:${port}/download?path=${encodeURIComponent(p)}`,
      uploadUrl: async p => `http://127.0.0.1:${port}/upload?path=${encodeURIComponent(p)}`,
    };
    return { machine, cmds, close: () => server.close() };
  }

  /** The watermark the download's own write stream takes, read from the stream module rather than assumed: `feed`
   * waits on drain for a write over it and never waits for one under it, which is what the two cases below turn on. */
  const WATERMARK = getDefaultHighWaterMark(false);

  /** A fetch that serves the file its URL names in `chunks` pieces, each asked for only once the reader has taken the
   * one before, and runs `atEnd` as the body closes. `size` is what a piece came to, which decides whether the write
   * of a piece hits the watermark. */
  function chunkedBody(chunks: number, atEnd: () => void = () => {}): { fetch: typeof globalThis.fetch; size: () => number; enqueued: () => number } {
    let size = 0;
    let enqueued = 0;
    const fetch: typeof globalThis.fetch = async url => {
      const body = readFileSync(new URL(String(url)).searchParams.get("path")!);
      size = Math.ceil(body.length / chunks);
      let at = 0;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(c) {
          await new Promise(r => setImmediate(r));
          if (at >= body.length) {
            atEnd();
            c.close();
            return;
          }
          c.enqueue(body.subarray(at, at + size));
          at += size;
          enqueued += 1;
        },
      }));
    };
    return { fetch, size: () => size, enqueued: () => enqueued };
  }

  const listing = (tgz: Buffer): string[] =>
    tarRead(["-tzf", "-"], tgz).toString().trim().split("\n").filter(l => l !== "").map(l => l.replace(/^\.\//, "").replace(/\/$/, "")).filter(l => l !== "." && l !== "").sort();

  it("the script tars the folder from its root, leaves every cache root the rule names behind, names them on stdout, and judges nothing under .git", async () => {
    const root = folder();
    const out = join(root, "..", `${basename(root)}.tgz`);
    dirs.push(out);
    const script = folderExportScript(root, RULE, out);
    const ran = await new Promise<ExecResult>(resolve => execFile("bash", ["-c", script], (err, stdout, stderr) => resolve({ exitCode: err === null ? 0 : 1, stdout, stderr })));
    expect(ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.trim().split("\n").sort()).toEqual([".DS_Store", ".cache", "deep/dir/.DS_Store", "dist", "myenv", "node_modules"]);
    expect(listing(readFileSync(out))).toEqual([".env", ".git", ".git/build", ".git/build/keep", ".git/config", "deep", "deep/dir", "my-cache-service", "my-cache-service/README.md", "notes", "notes/CacheNotes.md", "really-empty", "src", "src/a.ts", "src/cache-utils.ts", "src/dist"]);
    expect(existsSync(`${out}.list`)).toBe(false);
  });

  it("exportPaths under a cache rule leaves installs, build output and nested worktrees behind at every path, keeps the repository, and the cap is read after they are gone", async () => {
    const g = await guest();
    const root = mkdtempSync(join(tmpdir(), "wsp-vault-home-"));
    dirs.push(root);
    const put = (rel: string, text: string | Buffer): void => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put("proj/src/a.ts", "a\n");
    put("proj/apps/web/src/lib/lruCache.ts", "a source file whose name holds the word\n");
    put("proj/packages/collect/src/cache-names.ts", "another\n");
    put(".claude/projects/-root-my-cache-service/S1.jsonl", "a session folder whose name holds the word\n");
    put("proj/.git/config", "[core]\n");
    put("proj/.git/node_modules/keep", "nothing under .git is judged\n");
    put("proj/node_modules/big/blob", randomBytes(400_000));
    put("proj/dist/out.js", "output\n");
    put("proj/.claude/worktrees/wt/.git", "gitdir: /elsewhere/.git/worktrees/wt\n");
    put("proj/.claude/worktrees/wt/src/b.ts", "a nested checkout\n");
    put("notes.md", "kept\n");
    const rule: CacheRule = { dirs: ["node_modules", "dist", ".cache"], files: [".DS_Store"], markers: ["pyvenv.cfg", ".git"] };
    const paths = [join(root, "proj"), join(root, "notes.md"), join(root, ".claude")];
    try {
      await expect(exportPaths(g.machine, paths, { fetch: globalThis.fetch, maxBytes: 100_000 })).rejects.toMatchObject({ kind: "vaultTooLarge" });
      const tar = await exportPaths(g.machine, paths, { fetch: globalThis.fetch, maxBytes: 100_000, exclude: rule });
      const rel = (p: string): string => p.replace(/^\//, "");
      const names = listing(tar).map(l => l.startsWith(rel(root)) ? l.slice(rel(root).length + 1) : l);
      expect(names).toEqual([".claude", ".claude/projects", ".claude/projects/-root-my-cache-service", ".claude/projects/-root-my-cache-service/S1.jsonl", "notes.md", "proj", "proj/.claude", "proj/.claude/worktrees", "proj/.git", "proj/.git/config", "proj/.git/node_modules", "proj/.git/node_modules/keep", "proj/apps", "proj/apps/web", "proj/apps/web/src", "proj/apps/web/src/lib", "proj/apps/web/src/lib/lruCache.ts", "proj/packages", "proj/packages/collect", "proj/packages/collect/src", "proj/packages/collect/src/cache-names.ts", "proj/src", "proj/src/a.ts"]);
      const script = g.cmds.find(c => c.includes("find "))!;
      expect(script).toContain(`cd '/'`);
      const cache = `\\( \\( -type d \\( -name 'node_modules' -o -name 'dist' -o -name '.cache' \\) \\) -o \\( -type f \\( -name '.DS_Store' \\) \\) -o \\( -type d -exec test -f '{}/pyvenv.cfg' \\; \\) -o \\( -type d -exec test -f '{}/.git' \\; \\) \\)`;
      const where = paths.map(p => `'${rel(p)}'`).join(" ");
      expect(script).toContain(`find ${where} -mindepth 1 -path '*/.git' -prune -o ${cache} -prune -print > `);
      expect(script).toContain(`printf '%s\\0' ${where} > `);
      expect(script).toContain(`find ${where} -mindepth 1 \\( -path '*/.git' -o -path '*/.git/*' \\) -print0 -o ${cache} -prune -o -print0 >> `);
      expect(script).toMatch(/tar czf '\/tmp\/wsp-vault-[^']+\.tgz' --no-recursion --null -T '\/tmp\/wsp-vault-[^']+\.tgz\.keep'\n/);
      expect(g.cmds.filter(c => c.startsWith("rm -f"))).toHaveLength(2);
    } finally {
      g.close();
    }
  });

  it("exportPaths judges the paths it is handed too: the install a box's worktrees share at the top of the home never travels, and what is left fits the cap", async () => {
    const g = await guest();
    const root = mkdtempSync(join(tmpdir(), "wsp-vault-box-"));
    dirs.push(root);
    const put = (rel: string, text: string | Buffer): void => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put("wsp/src/a.ts", "the checkout the person works in\n");
    put("wsp/node_modules/big/blob", randomBytes(400_000));
    put("node_modules/big/blob", randomBytes(400_000));
    put(".pnpm-store/v3/files/00/deadbeef", randomBytes(400_000));
    put("notes.md", "kept\n");
    const rule: CacheRule = { dirs: ["node_modules", ".pnpm-store", "dist"], files: [".DS_Store"], markers: ["pyvenv.cfg", ".git"] };
    // Every top-level entry of the home, as the vault enumerates them.
    const paths = readdirSync(root).sort().map(name => join(root, name));
    try {
      const tar = await exportPaths(g.machine, paths, { fetch: globalThis.fetch, maxBytes: 100_000, exclude: rule });
      const rel = (p: string): string => p.replace(/^\//, "");
      const names = listing(tar).map(l => (l.startsWith(rel(root)) ? l.slice(rel(root).length + 1) : l));
      expect(names).toEqual(["notes.md", "wsp", "wsp/src", "wsp/src/a.ts"]);
      const script = g.cmds.find(c => c.includes("find "))!;
      const where = `'${rel(join(root, "notes.md"))}' '${rel(join(root, "wsp"))}'`;
      expect(script).toContain(`find ${where} -mindepth 1`);
      expect(script).toContain(`printf '%s\\0' ${where} > `);
    } finally {
      g.close();
    }
  });

  it("an export that names no path at all archives nothing: no find, no walk of the root it runs in, and the refusal about caches is not what it says", async () => {
    const g = await guest();
    try {
      const tar = await exportPaths(g.machine, [], { fetch: globalThis.fetch, exclude: RULE });
      expect(listing(tar)).toEqual([]);
      const script = g.cmds.find(c => c.includes("tar czf"))!;
      expect(script).toMatch(/^tar czf '\/tmp\/wsp-vault-[^']+\.tgz' --no-recursion --null -T \/dev\/null$/);
      expect(g.cmds.some(c => c.includes("find "))).toBe(false);
    } finally {
      g.close();
    }
  });

  it("refuses an export whose every path is a cache under the rule rather than running find with none", async () => {
    const g = await guest();
    try {
      await expect(exportPaths(g.machine, ["/root/node_modules", "/root/dist"], { fetch: globalThis.fetch, exclude: RULE })).rejects.toThrow(
        "vault export: every path named is a cache under the rule (/root/node_modules, /root/dist), so there is nothing to archive",
      );
      expect(g.cmds).toEqual([]);
    } finally {
      g.close();
    }
  });

  it("streams the archive into a file on this computer with its size known up front, names the excluded roots, and leaves nothing on the guest", async () => {
    const g = await guest();
    const root = folder();
    const dir = mkdtempSync(join(tmpdir(), "wsp-export-into-"));
    dirs.push(dir);
    const into = join(dir, "folder.tgz");
    try {
      const seen: { bytes: number; total: number }[] = [];
      const { bytes, excluded } = await exportFolder(g.machine, root, RULE, into, { fetch: globalThis.fetch, onProgress: p => seen.push(p) });
      expect(excluded).toEqual([".DS_Store", ".cache", "deep/dir/.DS_Store", "dist", "myenv", "node_modules"]);
      expect(statSync(into).size).toBe(bytes);
      expect(listing(readFileSync(into))).toContain("src/a.ts");
      expect(listing(readFileSync(into))).not.toContain("dist/out.js");
      expect(seen.at(-1)).toEqual({ bytes, total: bytes });
      expect(seen.every(p => p.total === bytes && p.bytes <= bytes)).toBe(true);
      const tmp = /tar czf '([^']+)'/.exec(g.cmds.find(c => c.includes("tar czf")) ?? "")?.[1];
      expect(tmp).toMatch(/^\/tmp\/wsp-out-/);
      expect(existsSync(tmp!)).toBe(false);
      expect(g.cmds.some(c => c.startsWith("rm -f ") && c.includes(tmp!))).toBe(true);
    } finally {
      g.close();
    }
  });

  it("a 6 MB body off the guest reports bytes that only go up, never runs the file ahead of them, and ends at the size the file takes", async () => {
    const g = await guest(256 * 1024);
    const root = folder();
    // Random bytes so the archive gzips to about its own size, several download chunks worth.
    writeFileSync(join(root, "src", "big.bin"), randomBytes(6 * 1024 * 1024));
    const dir = mkdtempSync(join(tmpdir(), "wsp-export-into-"));
    dirs.push(dir);
    const into = join(dir, "folder.tgz");
    try {
      const seen: { bytes: number; total: number }[] = [];
      const midStream: { disk: number; reported: number }[] = [];
      const { bytes } = await exportFolder(g.machine, root, RULE, into, {
        fetch: globalThis.fetch,
        onProgress: p => {
          seen.push(p);
          if (p.bytes > 0 && p.bytes < p.total) midStream.push({ disk: statSync(into).size, reported: p.bytes });
        },
      });
      expect(bytes).toBeGreaterThan(4 * 1024 * 1024);
      expect(seen.length).toBeGreaterThanOrEqual(4);
      expect(seen.map(p => p.bytes).every((b, i, all) => i === 0 || b > all[i - 1]!)).toBe(true);
      // The write stream holds a chunk until its watermark, so the file trails the progress; it never runs ahead of it.
      expect(midStream.every((m, i, all) => m.disk < bytes && m.disk <= m.reported && (i === 0 || m.disk >= all[i - 1]!.disk))).toBe(true);
      expect(statSync(into).size).toBe(bytes);
      expect(listing(readFileSync(into))).toContain("src/big.bin");
    } finally {
      g.close();
    }
  }, 60_000);

  it("progress arrives while the response is still open: every chunk of the body is reported before the body ends", async () => {
    const g = await guest();
    const root = folder();
    const dir = mkdtempSync(join(tmpdir(), "wsp-export-open-"));
    dirs.push(dir);
    const into = join(dir, "folder.tgz");
    const CHUNKS = 4;
    const seen: { bytes: number; total: number }[] = [];
    let reportedWhenBodyEnded = -1;
    const body = chunkedBody(CHUNKS, () => {
      reportedWhenBodyEnded = seen.filter(p => p.bytes > 0).length;
    });
    try {
      const { bytes } = await exportFolder(g.machine, root, RULE, into, { fetch: body.fetch, onProgress: p => seen.push(p) });
      // Every chunk is asked for behind a macrotask while the path from one arriving to its report is microtasks only,
      // so each report lands before the next chunk: a write over the watermark puts drain in that path and loses one.
      expect(body.size()).toBeLessThan(WATERMARK);
      expect(body.enqueued()).toBe(CHUNKS);
      expect(reportedWhenBodyEnded).toBe(CHUNKS);
      expect(seen.map(p => p.bytes).every((b, i, all) => i === 0 || b > all[i - 1]!)).toBe(true);
      expect(seen.at(-1)).toEqual({ bytes, total: bytes });
      expect(statSync(into).size).toBe(bytes);
      expect(listing(readFileSync(into))).toContain("src/a.ts");
    } finally {
      g.close();
    }
  }, 60_000);

  it("the archive lands as it arrives: a chunk over the watermark is on disk by the time its own progress line is out", async () => {
    const g = await guest();
    const root = folder();
    const CHUNKS = 4;
    // Twice the watermark to a chunk, and random so the archive gzips to about its own size: over the watermark the
    // write stream holds nothing back, since `feed` waits on drain and a drained write has reached the file.
    writeFileSync(join(root, "src", "big.bin"), randomBytes(2 * CHUNKS * WATERMARK));
    const dir = mkdtempSync(join(tmpdir(), "wsp-export-drain-"));
    dirs.push(dir);
    const into = join(dir, "folder.tgz");
    const midStream: { disk: number; reported: number }[] = [];
    const body = chunkedBody(CHUNKS);
    try {
      const { bytes } = await exportFolder(g.machine, root, RULE, into, {
        fetch: body.fetch,
        onProgress: p => {
          // The open runs on the thread pool, so a download that has written nothing has no file yet: that is no bytes
          // on disk, which is the answer this case is about, rather than a stat that throws.
          if (p.bytes > 0 && p.bytes < p.total) midStream.push({ disk: existsSync(into) ? statSync(into).size : 0, reported: p.bytes });
        },
      });
      expect(body.size()).toBeGreaterThan(WATERMARK);
      expect(midStream).toHaveLength(CHUNKS - 1);
      expect(midStream.map(m => m.disk)).toEqual(midStream.map(m => m.reported));
      expect(midStream.at(-1)!.disk).toBeGreaterThan(midStream[0]!.disk);
      expect(midStream.at(-1)!.disk).toBeLessThan(bytes);
      expect(statSync(into).size).toBe(bytes);
      expect(listing(readFileSync(into))).toContain("src/big.bin");
    } finally {
      g.close();
    }
  }, 60_000);

  it("exportPathsInto streams the paths into a file on this computer, and a download that fails or answers with no body leaves no half file behind", async () => {
    const g = await guest();
    const root = folder();
    const dir = mkdtempSync(join(tmpdir(), "wsp-export-into-"));
    dirs.push(dir);
    const into = join(dir, "state.tgz");
    const src = [{ root, paths: [join(root, "src")] }];
    try {
      const bytes = await exportPathsInto(g.machine, src, into, { fetch: globalThis.fetch });
      expect(statSync(into).size).toBe(bytes);
      expect(listing(readFileSync(into)).map(l => basename(l))).toEqual(["src", "a.ts", "cache-utils.ts", "dist"]);
      const gone = join(dir, "never.tgz");
      const refusing: typeof globalThis.fetch = async () => new Response(null, { status: 503 });
      await expect(exportPathsInto(g.machine, src, gone, { fetch: refusing })).rejects.toThrow(/HTTP 503/);
      expect(existsSync(gone)).toBe(false);
      const bodyless = join(dir, "bodyless.tgz");
      const empty: typeof globalThis.fetch = async () => new Response(null, { status: 200 });
      await expect(exportPathsInto(g.machine, src, bodyless, { fetch: empty })).rejects.toThrow(/HTTP 200 with no body/);
      expect(existsSync(bodyless)).toBe(false);
    } finally {
      g.close();
    }
  });

  it("exportPathsInto archives each group from its own root, so a copy under a mirror root travels at the path it mirrors", async () => {
    const g = await guest();
    const dir = mkdtempSync(join(tmpdir(), "wsp-export-groups-"));
    dirs.push(dir);
    const home = mkdtempSync(join(tmpdir(), "wsp-export-home-"));
    dirs.push(home);
    const mirror = mkdtempSync(join(tmpdir(), "wsp-export-mirror-"));
    dirs.push(mirror);
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "s.jsonl"), "a session\n");
    writeFileSync(join(home, "store.db"), "every project's rows\n");
    mkdirSync(join(mirror, home.slice(1)), { recursive: true });
    writeFileSync(join(mirror, home.slice(1), "store.db"), "this project's rows\n");
    const into = join(dir, "state.tgz");
    try {
      await exportPathsInto(
        g.machine,
        [
          { root: "/", paths: [join(home, "sessions")] },
          { root: mirror, paths: [join(mirror, home.slice(1), "store.db")] },
        ],
        into,
        { fetch: globalThis.fetch },
      );
      const out = mkdtempSync(join(tmpdir(), "wsp-export-out-"));
      dirs.push(out);
      execFileSync("tar", ["-xzf", into, "-C", out]);
      expect(readFileSync(join(out, home.slice(1), "sessions", "s.jsonl"), "utf8")).toBe("a session\n");
      expect(readFileSync(join(out, home.slice(1), "store.db"), "utf8")).toBe("this project's rows\n");
    } finally {
      g.close();
    }
  });

  /** Whether this computer's tar is the guest's: --recursive-unlink is GNU's, and the landing under test is the one
   * the runtime runs on a Linux guest. */
  const GNU_TAR = /GNU tar/.test(execFileSync("tar", ["--version"]).toString());

  /** The two homes a move onto a newer image has: the fork's, whose top-level entries the vault lists, and the new
   * machine's, which the image put there. */
  function homes(): { fork: string; image: string } {
    const root = mkdtempSync(join(tmpdir(), "wsp-move-"));
    dirs.push(root);
    const put = (rel: string, text: string): void => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put("fork/.zshrc", "the image's zshrc\n");
    put("fork/.gitconfig", "the fork's own gitconfig\n");
    put("fork/.claude/settings.json", "the image's settings\n");
    put("fork/.claude/CLAUDE.md", "the fork's own memory\n");
    put("fork/.claude/projects/-root-proj/S1.jsonl", "a session the fork wrote\n");
    put("fork/.config/nvim/init.lua", "the fork's own editor config\n");
    put("fork/proj/src/a.ts", "work\n");
    put("image/.zshrc", "v2 zshrc\n");
    put("image/.gitconfig", "v2 gitconfig\n");
    put("image/.claude/settings.json", "v2 settings\n");
    put("image/.claude/CLAUDE.md", "v2 memory\n");
    put("image/.config/gh/hosts.yml", "v2 sign-in\n");
    // Two files of the image's the fork deleted: one at the top of home, one inside a folder the image writes into.
    put("image/.bashrc", "v2 bashrc\n");
    put("image/.claude/agents/reviewer.md", "v2 reviewer\n");
    return { fork: join(root, "fork"), image: join(root, "image") };
  }

  /** What the comparison hands the export: the two files this fork never touched and the one only the new image
   * writes, as the runtime spells them, absolute under the fork's home. */
  const dropped = (fork: string): string[] => [`${fork}/.zshrc`, `${fork}/.claude/settings.json`, `${fork}/.config/gh/hosts.yml`, `${fork}/.bashrc`, `${fork}/.claude/agents/reviewer.md`];

  it("a move's archive leaves the dropped files out and their directories with them, and carries every other file the fork holds", async () => {
    const g = await guest();
    const { fork } = homes();
    try {
      const tar = await exportPaths(g.machine, readdirSync(fork).map(e => join(fork, e)), { fetch: globalThis.fetch, drop: dropped(fork) });
      const under = fork.replace(/^\//, "");
      expect(listing(tar).map(l => l.slice(under.length + 1))).toEqual([
        ".claude/CLAUDE.md",
        ".claude/projects",
        ".claude/projects/-root-proj",
        ".claude/projects/-root-proj/S1.jsonl",
        ".config/nvim",
        ".config/nvim/init.lua",
        ".gitconfig",
        "proj",
        "proj/src",
        "proj/src/a.ts",
      ]);
    } finally {
      g.close();
    }
  });

  it.skipIf(!GNU_TAR)("landed over the new image the way the upgrade lands it: untouched files are the image's, changed ones the fork's, a file only the image writes arrives, and the fork's project and sessions come whole", async () => {
    const g = await guest();
    const { fork, image } = homes();
    try {
      const tar = await exportPaths(g.machine, readdirSync(fork).map(e => join(fork, e)), { fetch: globalThis.fetch, drop: dropped(fork) });
      const depth = fork.replace(/^\//, "").split("/").length;
      tarRead(["xzf", "-", "-C", image, `--strip-components=${depth}`, "--recursive-unlink"], tar);
      const read = (rel: string): string => readFileSync(join(image, rel), "utf8");
      expect(read(".zshrc")).toBe("v2 zshrc\n");
      expect(read(".claude/settings.json")).toBe("v2 settings\n");
      expect(read(".gitconfig")).toBe("the fork's own gitconfig\n");
      expect(read(".claude/CLAUDE.md")).toBe("the fork's own memory\n");
      expect(read(".config/gh/hosts.yml")).toBe("v2 sign-in\n");
      expect(read(".claude/projects/-root-proj/S1.jsonl")).toBe("a session the fork wrote\n");
      expect(read(".config/nvim/init.lua")).toBe("the fork's own editor config\n");
      expect(read("proj/src/a.ts")).toBe("work\n");
      // A file of the image's the fork deleted comes back with the new image: an archive carries no deletion, and
      // the folder it sits in is held out of the archive so the copies beside it survive.
      expect(read(".bashrc")).toBe("v2 bashrc\n");
      expect(read(".claude/agents/reviewer.md")).toBe("v2 reviewer\n");
    } finally {
      g.close();
    }
  });

  it("a dropped path holding a glob character drops that path and nothing else, since find reads -path as a pattern", async () => {
    const g = await guest();
    const root = mkdtempSync(join(tmpdir(), "wsp-glob-"));
    dirs.push(root);
    mkdirSync(join(root, ".config"), { recursive: true });
    writeFileSync(join(root, ".config", "a[1].txt"), "the image wrote this one\n");
    writeFileSync(join(root, ".config", "a1.txt"), "the fork's own, which the pattern would eat\n");
    try {
      const tar = await exportPaths(g.machine, [join(root, ".config")], { fetch: globalThis.fetch, drop: [`${root}/.config/a[1].txt`] });
      const under = root.replace(/^\//, "");
      expect(listing(tar).map(l => l.slice(under.length + 1))).toEqual([".config/a1.txt"]);
    } finally {
      g.close();
    }
  });

  it("a folder that is not on the machine fails with a plain sentence before any download", async () => {
    const g = await guest();
    try {
      const missing = join(tmpdir(), "wsp-export-none-" + randomBytes(4).toString("hex"));
      await expect(exportFolder(g.machine, missing, RULE, join(tmpdir(), "wsp-never.tgz"), { fetch: globalThis.fetch })).rejects.toThrow(`${missing} is not a folder on the machine`);
      expect(g.cmds.some(c => c.includes("tar czf"))).toBe(false);
    } finally {
      g.close();
    }
  });
});
