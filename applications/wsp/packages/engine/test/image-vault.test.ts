// SPDX-License-Identifier: AGPL-3.0-only
// The image vault: what the seal takes off the builder, what an import lands,
// the one hash rule, and the guard that keeps the catalog's login paths and
// the pack's copy destinations from drifting apart.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { CLAUDE_CONFIG_REL, GUEST_HOME, loginStatePaths, CATALOG } from "@wsp/catalog";
import { exportImageVault, imageHash, importImageVault, refuseForeignMembers, refusedMember, vaultMembers } from "../src/image-vault.js";
import { EXEC_READ_CAP, tarOf } from "../src/vault.js";
import { copiedLoginDests } from "../src/golden-import.js";
import type { ExecResult, Machine } from "../src/machine.js";

const TAR_BYTES = tarOf([{ path: "root/.codex/auth.json", mode: 0o600, content: "{}" }]);

/** A guest holding the paths named, whose tar writes an archive of them, and whose signed URLs the fetch stub
 * answers. `tar` plants another archive, which is what a builder that writes its own bytes hands back. */
function guest(present: readonly string[], o: { size?: number; probeExit?: number; probeErr?: string; tar?: Buffer } = {}) {
  const archived = o.tar ?? tarOf(present.map(p => ({ path: p.replace(/^\//, ""), mode: 0o600, content: "x" })));
  const execCmds: string[] = [];
  const runs: string[] = [];
  const files = new Map<string, Buffer>();
  const machine: Machine = {
    id: "mg", kind: "sandbox", streamUrl: undefined,
    exec: async (cmd): Promise<ExecResult> => {
      execCmds.push(cmd);
      if (cmd.startsWith("for p in ")) return { exitCode: o.probeExit ?? 0, stdout: present.join("\n") + (present.length > 0 ? "\n" : ""), stderr: o.probeErr ?? "" };
      const made = /^tar czf '([^']+)'/.exec(cmd);
      if (made) files.set(made[1]!, archived);
      const sized = /^wc -c < '([^']+)'/.exec(cmd);
      if (sized) return { exitCode: 0, stdout: `${o.size ?? (files.get(sized[1]!)?.length ?? 0)}\n`, stderr: "" };
      const read = /^base64 < '([^']+)'/.exec(cmd);
      if (read) return { exitCode: 0, stdout: (files.get(read[1]!) ?? Buffer.alloc(0)).toString("base64"), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    run: async script => {
      runs.push(script);
      return machine.exec(script);
    },
    snapshot: async () => "snap", pause: async () => {}, resume: async () => {},
    kill: async () => {}, state: async () => "running" as const,
    downloadUrl: async p => `https://signed.example/dl?path=${encodeURIComponent(p)}`,
    uploadUrl: async p => `https://signed.example/ul?path=${encodeURIComponent(p)}`,
  };
  const puts: { url: string; body: Buffer }[] = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "PUT") {
      puts.push({ url: u, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: 200 });
    }
    const bytes = files.get(decodeURIComponent(new URL(u).searchParams.get("path") ?? ""));
    return bytes === undefined ? new Response("gone", { status: 404 }) : new Response(new Uint8Array(bytes), { status: 200 });
  });
  return { machine, execCmds, runs, puts, fetch, archived };
}

describe("image vault", () => {
  it("archives only the paths the machine has, counts them, and hashes the tar it brought down", async () => {
    const here = `${GUEST_HOME}/.codex/auth.json`;
    const gone = `${GUEST_HOME}/.aws`;
    const g = guest([here]);
    const vault = await exportImageVault(g.machine, [here, gone], { fetch: g.fetch });
    expect(vault.paths).toBe(1);
    expect(vault.held).toEqual([here]);
    expect(vault.tar.equals(g.archived)).toBe(true);
    expect(vault.sha256).toBe(createHash("sha256").update(g.archived).digest("hex"));
    const tar = g.execCmds.find(c => c.startsWith("tar czf"))!;
    expect(tar).toContain("'root/.codex/auth.json'");
    expect(tar).not.toContain(".aws");
  });

  it("a machine whose provider mints no download URL hands the archive back through one command", async () => {
    const here = `${GUEST_HOME}/.codex/auth.json`;
    const g = guest([here]);
    const vault = await exportImageVault(g.machine, [here], { readRoad: "exec" });
    expect(vault.tar.equals(g.archived)).toBe(true);
    expect(vault.paths).toBe(1);
    expect(g.execCmds.some(c => c.startsWith("base64 < "))).toBe(true);
    expect(g.fetch).not.toHaveBeenCalled();
  });

  it("an archive too big for that road is refused on its size, before any of it is read back", async () => {
    const here = `${GUEST_HOME}/.aws`;
    const g = guest([here], { size: EXEC_READ_CAP + 1 });
    await expect(exportImageVault(g.machine, [here], { readRoad: "exec" })).rejects.toMatchObject({ kind: "vaultTooLarge" });
    expect(g.execCmds.some(c => c.startsWith("base64 < "))).toBe(false);
  });

  it("a probe the machine would not run is a failure, not an empty answer: nothing is archived and nothing is sealed", async () => {
    const g = guest([], { probeExit: 127, probeErr: "bash: for: command not found" });
    await expect(exportImageVault(g.machine, [`${GUEST_HOME}/.codex/auth.json`], { fetch: g.fetch })).rejects.toThrow(/would not say which/);
    expect(g.execCmds.some(c => c.startsWith("tar czf"))).toBe(false);
  });

  it("a machine holding none of them archives nothing and says so", async () => {
    const g = guest([]);
    const vault = await exportImageVault(g.machine, [`${GUEST_HOME}/.aws`], { fetch: g.fetch });
    expect(vault.paths).toBe(0);
    expect(g.execCmds.some(c => c.includes("--no-recursion"))).toBe(true);
  });

  it("lands the archive over the root in one upload, merging into what the pack already wrote", async () => {
    const g = guest([]);
    await importImageVault(g.machine, TAR_BYTES, { fetch: g.fetch });
    expect(g.puts).toHaveLength(1);
    const script = g.runs.find(r => r.includes("tar xzf"))!;
    expect(script).toContain("tar xzf - -C '/' --no-same-owner");
    expect(script).not.toContain("--recursive-unlink");
  });

  it("the hash is one rule: stable, moved by the recipe, moved by the vault, and a record with no vault is its own", () => {
    expect(imageHash("r1", "v1", [])).toBe(imageHash("r1", "v1", []));
    expect(imageHash("r1", "v1", [])).not.toBe(imageHash("r2", "v1", []));
    expect(imageHash("r1", "v1", [])).not.toBe(imageHash("r1", "v2", []));
    expect(imageHash("r1", undefined, [])).not.toBe(imageHash("r1", "0".repeat(64), []));
    expect(imageHash("r1", undefined, [])).toHaveLength(64);
  });

  it("the hash moves with a pin: a version, a checksum or a row pinned anew each move it, the order of the pins does not, and a row that installs latest counts by its mark and not by what one seal got", () => {
    const gh = { id: "tools/catalog/gh", tag: "v2.86.0", sha256: "b".repeat(64) };
    const wrangler = { id: "tools/npm/wrangler", tag: "4.1.0" };
    const base = imageHash("r1", "v1", [gh, wrangler]);
    expect(base).toBe(imageHash("r1", "v1", [wrangler, gh]));
    expect(base).not.toBe(imageHash("r1", "v1", []));
    expect(base).not.toBe(imageHash("r1", "v1", [gh]));
    expect(base).not.toBe(imageHash("r1", "v1", [gh, { ...wrangler, tag: "4.2.0" }]));
    expect(base).not.toBe(imageHash("r1", "v1", [{ ...gh, sha256: "c".repeat(64) }, wrangler]));
    // Two seals of a row that installs latest got different versions of it; the image is the same image.
    const tmux = { id: "tools/catalog/tmux", tag: "3.3a-3", latest: true as const };
    expect(imageHash("r1", "v1", [tmux])).toBe(imageHash("r1", "v1", [{ ...tmux, tag: "3.4-1" }]));
    // Such a row is still a pinned row: a record that never read it is another image.
    expect(imageHash("r1", "v1", [tmux])).not.toBe(imageHash("r1", "v1", []));
  });

  it("every login the pack copies onto a machine lands under some catalog row's state on the machine", () => {
    // The `.claude/` rewrite is the host's own (init-import.ts guestPath) and the dependency arrow keeps this test
    // from importing it, so this line is the one copy of that rule: move it here when it moves there.
    const held = new Set(CATALOG.flatMap(e => loginStatePaths(e)));
    for (const dest of copiedLoginDests()) {
      const path = `${GUEST_HOME}/${dest.startsWith(".claude/") ? `${CLAUDE_CONFIG_REL}/${dest.slice(".claude/".length)}` : dest}`;
      const under = [...held].some(h => path === h || path.startsWith(`${h}/`));
      expect(under, `${path} is copied onto the machine and no row's stateOnMachine holds it`).toBe(true);
    }
  });
});

/** Tar header blocks written by hand: the archives a hostile builder would write cannot come out of `tarOf`, which
 * writes well-formed ustar members alone. */
const BLOCK = 512;
function header(o: { name: string; type?: string; size?: number; target?: string; magic?: string; checksum?: string; sizeField?: Buffer; prefix?: string }): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(o.name, 0, 100);
  h.write("0000600\0", 100, 8);
  h.write("0000000\0", 108, 8);
  h.write("0000000\0", 116, 8);
  if (o.sizeField !== undefined) o.sizeField.copy(h, 124);
  else h.write(`${(o.size ?? 0).toString(8).padStart(11, "0")}\0`, 124, 12);
  h.write("14000000000\0", 136, 12);
  h.write("        ", 148, 8);
  h.write(o.type ?? "0", 156, 1);
  if (o.target !== undefined) h.write(o.target, 157, 100);
  h.write(o.magic ?? "ustar\0", 257, 6);
  h.write("00", 263, 2);
  if (o.prefix !== undefined) h.write(o.prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(o.checksum ?? `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}
const filled = (text: string): Buffer => {
  const b = Buffer.alloc(Math.max(1, Math.ceil(Buffer.byteLength(text) / BLOCK)) * BLOCK);
  b.write(text);
  return b;
};
const archive = (...blocks: Buffer[]): Buffer => gzipSync(Buffer.concat([...blocks, Buffer.alloc(BLOCK * 2)]));

const HELD = ["/root/.codex/auth.json", "/root/.config/gh"];

describe("the member rule the seal and the copy both read", () => {
  it("an archive whose members are all under the asked paths reads them and lands as today", async () => {
    const tar = tarOf([
      { path: "root/.codex/auth.json", mode: 0o600, content: "{}" },
      { path: "root/.config/gh", mode: 0o700, dir: true },
      { path: "root/.config/gh/hosts.yml", mode: 0o600, content: "x" },
      { path: "root/.config/gh/link", target: "hosts.yml" },
    ]);
    expect(vaultMembers("import", tar).map(m => m.name)).toEqual(["root/.codex/auth.json", "root/.config/gh", "root/.config/gh/hosts.yml", "root/.config/gh/link"]);
    expect(() => refuseForeignMembers("import", tar, HELD)).not.toThrow();
    const g = guest([]);
    await importImageVault(g.machine, tar, { fetch: g.fetch });
    expect(g.puts).toHaveLength(1);
  });

  it("a member outside the asked paths, a name that walks out, a link out and a device node each refuse the whole archive in one sentence naming the member, and nothing is handed to a machine", async () => {
    const cases: [string, Buffer, RegExp][] = [
      ["etc/cron.d/x", tarOf([{ path: "etc/cron.d/x", mode: 0o644, content: "* * * * * root sh" }]), /etc\/cron\.d\/x/],
      ["root/../etc/x", tarOf([{ path: "root/../etc/x", mode: 0o644, content: "x" }]), /walks out/],
      ["a symbolic link out", tarOf([{ path: "root/.config/gh", target: "/etc" }]), /points at \/etc/],
      ["a hard link out of a held folder", archive(header({ name: "root/.config/gh/x", type: "1", target: "etc/shadow" })), /points at etc\/shadow/],
      ["a device node", archive(header({ name: "root/.codex/auth.json", type: "3" })), /type flag is 3/],
    ];
    for (const [what, tar, reads] of cases) {
      const g = guest([]);
      expect(() => refuseForeignMembers("import", tar, HELD), what).toThrow(reads);
      expect(() => refuseForeignMembers("import", tar, HELD), what).toThrow(/nothing of it was imported/);
      expect(() => refuseForeignMembers("seal", tar, HELD), what).toThrow(/the seal is refused and no version is recorded/);
      expect(g.puts, what).toHaveLength(0);
      expect(g.execCmds, what).toHaveLength(0);
    }
  });

  it("a pax size is honoured, so a header planted inside a member's data is data and the member behind it is read", () => {
    const tar = archive(
      header({ name: "root/.codex/auth.json", type: "x", size: 13 }),
      filled("13 size=1024\n"),
      header({ name: "root/.codex/auth.json", size: 512 }),
      filled("the first block of the member's data"),
      header({ name: "root/.config/gh/hosts.yml", size: 512 }),
      header({ name: "etc/cron.d/x" }),
    );
    expect(() => refuseForeignMembers("import", tar, HELD)).toThrow(/etc\/cron\.d\/x/);
  });

  it("a pax path and linkpath are what the member is judged by", () => {
    const named = archive(header({ name: "root/.codex/auth.json", type: "x", size: 25 }), filled("25 path=etc/cron.d/x\n"), header({ name: "root/.codex/auth.json" }));
    expect(() => refuseForeignMembers("import", named, HELD)).toThrow(/etc\/cron\.d\/x/);
    const pointed = archive(header({ name: "root/.codex/auth.json", type: "x", size: 26 }), filled("26 linkpath=/etc/shadow\n"), header({ name: "root/.codex/auth.json", type: "2", target: "auth.json" }));
    expect(() => refuseForeignMembers("import", pointed, HELD)).toThrow(/points at \/etc\/shadow/);
  });

  it("a GNU long name is honoured for the header behind it, and a long name beside a long link target is one member", () => {
    const long = `etc/${"d".repeat(120)}/x`;
    const tar = archive(header({ name: "././@LongLink", type: "L", size: long.length + 1 }), filled(`${long}\0`), header({ name: "root/.codex/auth.json" }));
    expect(() => refuseForeignMembers("import", tar, HELD)).toThrow(new RegExp(long.replace(/\//g, "\\/")));
    const target = `/etc/${"e".repeat(120)}/secret`;
    const both = archive(
      header({ name: "././@LongLink", type: "K", size: target.length + 1 }),
      filled(`${target}\0`),
      header({ name: "././@LongLink", type: "L", size: long.length + 1 }),
      filled(`${long}\0`),
      header({ name: "root/.config/gh/link", type: "2", target: "hosts.yml" }),
    );
    expect(() => refuseForeignMembers("import", both, HELD)).toThrow(new RegExp(long.replace(/\//g, "\\/")));
    const twice = archive(header({ name: "x", type: "L", size: 6 }), filled("etc/x\0"), header({ name: "x", type: "L", size: 6 }), filled("etc/y\0"), header({ name: "root/.codex/auth.json" }));
    expect(() => vaultMembers("import", twice)).toThrow(/two long name entries of the same kind/);
  });

  it("a header that fails its own checksum is refused, and the members behind it are never read", () => {
    const tar = archive(header({ name: "root/.codex/auth.json", checksum: "000000\0 " }), header({ name: "etc/cron.d/x" }));
    expect(() => vaultMembers("import", tar)).toThrow(/fails its own checksum/);
    expect(() => vaultMembers("import", tar)).not.toThrow(/etc\/cron\.d\/x/);
  });

  it("a base-256 numeric, a global pax record, an unknown type flag and a foreign magic are each a refusal", () => {
    const base256 = Buffer.alloc(12);
    base256[0] = 0x80;
    base256[11] = 1;
    expect(() => vaultMembers("import", archive(header({ name: "root/.codex/auth.json", sizeField: base256 })))).toThrow(/base-256/);
    expect(() => vaultMembers("import", archive(header({ name: "PaxHeaders/g", type: "g", size: 10 }), filled("10 x=y\n")))).toThrow(/type flag is g/);
    expect(() => vaultMembers("import", archive(header({ name: "root/.codex/auth.json", type: "7" })))).toThrow(/type flag is 7/);
    expect(() => vaultMembers("import", archive(header({ name: "root/.codex/auth.json", magic: "wsp\0\0\0" })))).toThrow(/neither a ustar nor a GNU header/);
  });

  it("a pax key this reading does not read, and a pax record beside a long name for one member, are refusals", () => {
    expect(() => vaultMembers("import", archive(header({ name: "x", type: "x", size: 30 }), filled("30 SCHILY.xattr.user.x=y\n"), header({ name: "root/.codex/auth.json" })))).toThrow(/SCHILY\.xattr\.user\.x/);
    const both = archive(header({ name: "x", type: "x", size: 25 }), filled("25 path=etc/cron.d/x\n"), header({ name: "@LongLink", type: "L", size: 5 }), filled("etc\0"), header({ name: "root/.codex/auth.json" }));
    expect(() => vaultMembers("import", both)).toThrow(/both a pax record and a long name/);
  });

  it("two gzip members concatenated read as one archive, and bytes behind the last that are no member are a refusal", () => {
    const blocks = Buffer.concat([header({ name: "root/.codex/auth.json" }), header({ name: "etc/cron.d/x" }), Buffer.alloc(BLOCK * 2)]);
    const split = Buffer.concat([gzipSync(blocks.subarray(0, BLOCK)), gzipSync(blocks.subarray(BLOCK))]);
    expect(vaultMembers("import", split).map(m => m.name)).toEqual(["root/.codex/auth.json", "etc/cron.d/x"]);
    expect(() => vaultMembers("import", Buffer.concat([archive(header({ name: "root/.codex/auth.json" })), Buffer.from("trailing")]))).toThrow(/do not decompress/);
  });

  it("a member whose data runs past the end of the archive is a refusal, as is an archive that never ends", () => {
    expect(() => vaultMembers("import", archive(header({ name: "root/.codex/auth.json", size: 4096 })))).toThrow(/runs past the end/);
    expect(() => vaultMembers("import", gzipSync(header({ name: "root/.codex/auth.json" })))).toThrow(/without the two zero blocks/);
  });

  it("the rule reads a folder and a link that stay inside, and a relative link that climbs out", () => {
    expect(refusedMember({ name: "root/.config/gh/", kind: "dir" }, HELD)).toBeUndefined();
    expect(refusedMember({ name: "./root/.config/gh/x", kind: "file" }, HELD)).toBeUndefined();
    expect(refusedMember({ name: "root/.config/gh/x", kind: "symlink", target: "../gh/hosts.yml" }, HELD)).toBeUndefined();
    expect(refusedMember({ name: "root/.config/gh/x", kind: "symlink", target: "../../.ssh/id_ed25519" }, HELD)).toMatch(/points at/);
  });

  it("a hard link's target is an archive name rooted where tar extracts, never a path from the link's own folder", () => {
    // tar links the new name to that member itself, so a name inside a held folder linked to a name outside one is
    // that outside file standing inside the copy. Read against the link's own folder it would pass as
    // /root/.config/gh/etc/shadow, which is under the held folder and lands nowhere.
    expect(refusedMember({ name: "root/.config/gh/x", kind: "hardlink", target: "etc/shadow" }, HELD)).toMatch(/points at etc\/shadow/);
    expect(refusedMember({ name: "root/.config/gh/x", kind: "hardlink", target: "/etc/shadow" }, HELD)).toMatch(/points at \/etc\/shadow/);
    expect(refusedMember({ name: "root/.config/gh/x", kind: "hardlink", target: "root/.config/gh/hosts.yml" }, HELD)).toBeUndefined();
    // A symbolic link with the same words is a path on the guest read from the folder the link lands in, and that
    // one stays inside.
    expect(refusedMember({ name: "root/.config/gh/x", kind: "symlink", target: "hosts.yml" }, HELD)).toBeUndefined();
    const tar = archive(header({ name: "root/.config/gh/x", type: "1", target: "etc/shadow" }));
    expect(() => refuseForeignMembers("import", tar, ["/root/.config/gh"])).toThrow(/points at etc\/shadow/);
  });
});

describe("the seal reads the archive its builder handed back", () => {
  it("a builder that answers a member outside the asked paths fails the seal with the member named", async () => {
    const here = `${GUEST_HOME}/.codex/auth.json`;
    const g = guest([here], { tar: tarOf([{ path: "root/.codex/auth.json", mode: 0o600, content: "{}" }, { path: "etc/cron.d/x", mode: 0o644, content: "x" }]) });
    await expect(exportImageVault(g.machine, [here], { fetch: g.fetch })).rejects.toThrow(/etc\/cron\.d\/x/);
  });

  it("a builder that answers exactly the asked paths seals with the list it was asked for", async () => {
    const here = `${GUEST_HOME}/.codex/auth.json`;
    const g = guest([here]);
    expect((await exportImageVault(g.machine, [here, `${GUEST_HOME}/.aws`], { fetch: g.fetch })).held).toEqual([here]);
  });
});
