// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REPO } from "../scripts/bundles.mjs";
import { refusal, runRefusal, sharedLibrariesNamed } from "../scripts/daemon-binary.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const script = join(repo, "packages", "wspx", "scripts", "daemon-binary.mjs");
const SLUG = new URL(REPO).pathname.slice(1);
const HEAD = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const OTHER = "0".repeat(40);
/** A triple the host names no target for, so what a case stages lands where nothing else in this checkout reads it. */
const TRIPLE = "riscv64gc-unknown-linux-gnu";
const staged = join(repo, "packages", "wspx", "daemon", TRIPLE);
const made: string[] = [];

afterEach(() => {
  for (const dir of [...made.splice(0), staged]) rmSync(dir, { recursive: true, force: true });
});

/** A folder with one artifact in it, as a download leaves it. */
function artifacts(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-artifacts-"));
  made.push(dir);
  mkdirSync(join(dir, `wsp-daemon-${TRIPLE}`));
  writeFileSync(join(dir, `wsp-daemon-${TRIPLE}`, `wsp-daemon-${TRIPLE}`), "a binary of its own\n");
  return dir;
}

/** A gh of its own on PATH: it answers one run record, writes the folder a download of that run would leave, and
 * records every call, so a case reads whether anything was downloaded at all. */
function stubGh(record: unknown): { bin: string; calls: () => string } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-gh-"));
  made.push(dir);
  writeFileSync(join(dir, "run.json"), JSON.stringify(record));
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      'd=$(dirname "$0")',
      'echo "$*" >> "$d/calls"',
      'case "$1" in',
      '  api) cat "$d/run.json" ;;',
      "  run)",
      '    while [ "$#" -gt 0 ]; do case "$1" in --dir) into="$2" ;; esac; shift; done',
      `    mkdir -p "$into/wsp-daemon-${TRIPLE}"`,
      `    printf 'a binary of its own\\n' > "$into/wsp-daemon-${TRIPLE}/wsp-daemon-${TRIPLE}"`,
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "gh"), 0o755);
  return { bin: dir, calls: () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "") };
}

/** The script as a person runs it: that gh first on PATH, and no workflow run around it. */
function run(bin: string, ...args: string[]): { ok: boolean; said: string } {
  const { GITHUB_ACTIONS: _inAnActionsRun, ...env } = process.env;
  const ran = spawnSync("node", [script, ...args], { encoding: "utf8", env: { ...env, PATH: `${bin}:${process.env["PATH"] ?? ""}` } });
  return { ok: ran.status === 0, said: `${ran.stdout}${ran.stderr}`.trim() };
}

interface Shape {
  /** The libraries the dynamic segment names as needed. */
  needed?: string[];
  /** Whether the file carries a dynamic segment at all; a plain static binary carries none. */
  dynamic?: boolean;
  /** Whether the file carries a section header table; a strip may leave the header's section fields at zero. */
  sections?: boolean;
}

/** A 64-bit little-endian ELF file laid out as the loader reads it: a program header table with one PT_LOAD over
 * the whole file and, when it is dynamic, a PT_DYNAMIC segment whose entries name the string table and the needed
 * libraries. The section header table, when there is one, describes the same string table and dynamic array. */
function elf({ needed = [], dynamic = true, sections = true }: Shape = {}): Buffer {
  const headerSize = 64;
  const segmentCount = dynamic ? 2 : 1;
  const programAt = headerSize;
  const stringsAt = programAt + 56 * segmentCount;
  const strings = Buffer.from(`\0${needed.map(n => `${n}\0`).join("")}`);
  const dynamicAt = stringsAt + strings.length;
  const entries: [bigint, bigint][] = [];
  let offset = 1;
  for (const name of needed) {
    entries.push([1n, BigInt(offset)]);
    offset += name.length + 1;
  }
  entries.push([5n, BigInt(stringsAt)], [0n, 0n]);
  const dynamicBytes = Buffer.alloc(dynamic ? 16 * entries.length : 0);
  entries.forEach(([tag, value], i) => {
    if (!dynamic) return;
    dynamicBytes.writeBigInt64LE(tag, i * 16);
    dynamicBytes.writeBigUInt64LE(value, i * 16 + 8);
  });
  const sectionsAt = dynamicAt + dynamicBytes.length;
  const sectionBytes = Buffer.alloc(sections ? 64 * 3 : 0);
  const total = sectionsAt + sectionBytes.length;
  const program = Buffer.alloc(56 * segmentCount);
  const segment = (i: number, type: number, at: number, size: number) => {
    program.writeUInt32LE(type, i * 56);
    program.writeBigUInt64LE(BigInt(at), i * 56 + 8);
    program.writeBigUInt64LE(BigInt(at), i * 56 + 16);
    program.writeBigUInt64LE(BigInt(size), i * 56 + 32);
  };
  segment(0, 1, 0, total);
  if (dynamic) segment(1, 2, dynamicAt, dynamicBytes.length);
  if (sections) {
    const section = (i: number, type: number, at: number, size: number, link: number) => {
      sectionBytes.writeUInt32LE(type, i * 64 + 4);
      sectionBytes.writeBigUInt64LE(BigInt(at), i * 64 + 0x18);
      sectionBytes.writeBigUInt64LE(BigInt(size), i * 64 + 0x20);
      sectionBytes.writeUInt32LE(link, i * 64 + 0x28);
    };
    section(1, 3, stringsAt, strings.length, 0);
    if (dynamic) section(2, 6, dynamicAt, dynamicBytes.length, 1);
  }
  const header = Buffer.alloc(headerSize);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2;
  header[5] = 1;
  header.writeBigUInt64LE(BigInt(programAt), 0x20);
  header.writeUInt16LE(56, 0x36);
  header.writeUInt16LE(segmentCount, 0x38);
  if (sections) {
    header.writeBigUInt64LE(BigInt(sectionsAt), 0x28);
    header.writeUInt16LE(64, 0x3a);
    header.writeUInt16LE(3, 0x3c);
  }
  return Buffer.concat([header, program, strings, dynamicBytes, sectionBytes]);
}

describe("the daemon binary staged for a Linux target is static", () => {
  it("reads the shared libraries a binary names off its dynamic segment, and none off a static one", () => {
    expect(sharedLibrariesNamed(elf({ needed: ["libseccomp.so.2", "libc.so.6"] }))).toEqual(["libseccomp.so.2", "libc.so.6"]);
    expect(sharedLibrariesNamed(elf({ needed: [] }))).toEqual([]);
    expect(sharedLibrariesNamed(elf({ dynamic: false }))).toEqual([]);
    expect(() => sharedLibrariesNamed(Buffer.from("#!/bin/sh\n"))).toThrow("not a 64-bit little-endian ELF file");
  });

  it("reads the loader's headers, so a binary stripped of its section table still names what it loads", () => {
    const stripped = elf({ needed: ["libseccomp.so.2"], sections: false });
    expect(stripped.readBigUInt64LE(0x28)).toBe(0n);
    expect(stripped.readUInt16LE(0x3c)).toBe(0);
    expect(sharedLibrariesNamed(stripped)).toEqual(["libseccomp.so.2"]);
  });

  it("refuses a musl binary that names a shared library, in a sentence naming the library and where to build", () => {
    const why = refusal("/build/wsp-daemon", "x86_64-unknown-linux-musl", elf({ needed: ["libseccomp.so.2"] }));
    expect(why).toBe("/build/wsp-daemon names shared libraries (libseccomp.so.2) and the Linux daemon is one static binary that loads none: build it in daemon/, where libseccomp links statically");
    expect(refusal("/build/wsp-daemon", "aarch64-unknown-linux-musl", elf({ needed: ["libseccomp.so.2"], sections: false }))).toContain("libseccomp.so.2");
  });

  it("places a plain static binary, one whose dynamic segment names nothing, and a Mac binary without reading it as ELF", () => {
    expect(refusal("/build/wsp-daemon", "x86_64-unknown-linux-musl", elf({ dynamic: false }))).toBeUndefined();
    expect(refusal("/build/wsp-daemon", "x86_64-unknown-linux-musl", elf({ needed: [] }))).toBeUndefined();
    expect(refusal("/build/wsp-daemon", "aarch64-apple-darwin", Buffer.from("\xcf\xfa\xed\xfe"))).toBeUndefined();
  });
});

describe("the run a daemon binary staged outside a workflow run comes from", () => {
  it("refuses a run built in another repository, naming both", () => {
    expect(runRefusal(9, { head_repository: { full_name: "someone/wsp" }, head_sha: HEAD }, HEAD)).toBe(
      `run 9 was built in someone/wsp, and the daemon binaries staged here come from ${SLUG}: name a run of ${SLUG}`,
    );
    expect(runRefusal(9, {}, HEAD)).toContain("a repository gh did not name");
  });

  it("refuses a run of another commit, naming both, and takes one of this commit", () => {
    expect(runRefusal(9, { head_repository: { full_name: SLUG }, head_sha: OTHER }, HEAD)).toBe(
      `run 9 built ${OTHER}, and this checkout is at ${HEAD}: name a run of this commit`,
    );
    expect(runRefusal(9, { head_repository: { full_name: SLUG }, head_sha: HEAD }, HEAD)).toBeUndefined();
  });

  it("refuses a folder someone filled, since outside a run nothing binds one to the run that built it", () => {
    const { bin } = stubGh({});
    const ran = run(bin, "--from-artifacts", artifacts());
    expect(ran.ok).toBe(false);
    expect(ran.said).toContain("outside a workflow run the daemon binaries come from --from-run <id>, which checks the run and downloads it");
    expect(existsSync(staged)).toBe(false);
  });

  it("says a refusal in one sentence, with no stack under it", () => {
    const { bin } = stubGh({});
    const ran = run(bin, "--from-artifacts", artifacts());
    expect(ran.ok).toBe(false);
    expect(ran.said).toBe("outside a workflow run the daemon binaries come from --from-run <id>, which checks the run and downloads it");
  });

  it("downloads nothing when the run it is told to read was built elsewhere or on another commit", () => {
    for (const record of [
      { head_repository: { full_name: "someone/wsp" }, head_sha: HEAD },
      { head_repository: { full_name: SLUG }, head_sha: OTHER },
    ]) {
      const gh = stubGh(record);
      const ran = run(gh.bin, "--from-run", "42");
      expect(ran.ok).toBe(false);
      expect(gh.calls()).toContain(`api repos/${SLUG}/actions/runs/42`);
      expect(gh.calls()).not.toContain("run download");
      expect(existsSync(staged)).toBe(false);
    }
  });

  it("downloads that run's own artifacts and stages what it downloaded", () => {
    const gh = stubGh({ head_repository: { full_name: SLUG }, head_sha: HEAD });
    const ran = run(gh.bin, "--from-run", "42");
    expect(ran.ok, ran.said).toBe(true);
    expect(gh.calls()).toContain(`run download 42 -R ${SLUG} --pattern wsp-daemon-* --dir`);
    expect(readFileSync(join(staged, "wsp-daemon"), "utf8")).toBe("a binary of its own\n");
  });
});
