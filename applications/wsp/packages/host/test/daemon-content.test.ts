// SPDX-License-Identifier: AGPL-3.0-only
// The version in the hello is the only thing that tells a host a machine's
// daemon is behind, so content that changes under an unchanged version reaches
// no machine already running. This hashes what a deploy installs and holds it
// against the last sha in the protocol's DAEMON_CONTENTS. Sources, not the
// built binary: a build differs by toolchain and machine, and the sources are
// what a version stands for.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_CONTENT_SHA, DAEMON_ROOTS_PATH, DAEMON_VERSION, workScoreLine } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CLOUD_PLACE, daemonUnit, deployScript, openShimScript } from "../src/doctor.js";
import { GUEST_DAEMON_TARGETS } from "../src/daemon-binary.js";
import { contentGateEnforced } from "./content-gate.js";

const DAEMON_TREE = fileURLToPath(new URL("../../../daemon/", import.meta.url));
// A fixed hex token: the deploy writes the token it is given, and which one cannot be what moves the sha.
const TOKEN = "aabbcc";
// The suffixed script carries every line the bare one has and two of its own.
const SUFFIX = ".preview.example.com";
// One chip a guest can be: the unit names the binary by a path that carries the chip's target triple.
const GUEST_TARGET = GUEST_DAEMON_TARGETS[0]!;

/** Every file under a folder, relative and sorted, so the walk reads the same whatever the folder's own path is. */
function relPaths(dir: string, keep: (name: string) => boolean, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? relPaths(join(dir, e.name), keep, `${prefix}${e.name}/`) : keep(e.name) ? [`${prefix}${e.name}`] : []))
    .sort();
}

const isSource = (name: string): boolean => name.endsWith(".rs") || name === "Cargo.toml";
const isFixture = (name: string): boolean => name.endsWith(".json");
/** A crate's tests/ folder is built for a test run and never linked into the binary, so nothing under it reaches a
 * guest and a change there must not cut a version. An inline #[cfg(test)] module stays hashed: the file holding it
 * ships, and reading past it would cost a Rust parser here. */
const underTests = (rel: string): boolean => /(^|\/)tests\//.test(rel);

/** A file's text as the sha reads it. Two files carry the version itself, in Rust and in the fixture the Rust is
 * held to, and a sha over the version would move the moment it was recorded: the line and the key that hold it
 * are taken out, and every cap and default beside them stays in, so a changed cap moves the version and the
 * version never chases its own hash. */
function hashed(rel: string, text: string): string {
  if (rel.endsWith("/numbers.rs")) return text.split("\n").filter(line => !line.includes("DAEMON_VERSION")).join("\n");
  if (rel.endsWith("/numbers.json")) {
    const { daemonVersion: _version, ...numbers } = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(numbers);
  }
  return text;
}

/** What a deploy leaves on a guest and this can hash: the Rust sources the binary is built from, each crate's
 * manifest and none of its tests/ folder, the lock that pins every dependency, the C library the Linux builds link
 * and the release it is pinned to, the contract fixtures the binary's words, numbers and frames are held to,
 * DAEMON_ROOTS_PATH and the work-score line the daemon reads through that contract, and the scripts the host
 * writes beside the binary, whose content outlives the deploy that wrote it. */
function daemonContentSha(daemonTree: string, scripts: string[]): string {
  const h = createHash("sha256");
  const crates = join(daemonTree, "crates");
  for (const rel of relPaths(crates, isSource).filter(rel => !underTests(rel))) h.update(`crates/${rel}\n${hashed(`crates/${rel}`, readFileSync(join(crates, rel), "utf8"))}\n`);
  for (const file of ["Cargo.toml", "Cargo.lock", "scripts/libseccomp-archive.sh"]) h.update(`${file}\n${readFileSync(join(daemonTree, file), "utf8")}\n`);
  const contract = join(daemonTree, "fixtures", "contract");
  for (const rel of relPaths(contract, isFixture)) h.update(`fixtures/contract/${rel}\n${hashed(`fixtures/contract/${rel}`, readFileSync(join(contract, rel), "utf8"))}\n`);
  h.update(`${DAEMON_ROOTS_PATH}\n`);
  h.update(`${workScoreLine()}\n`);
  for (const s of scripts) h.update(`${s}\n`);
  return h.digest("hex");
}

// A fork's place, which is what a golden is built under: the sha pins what lands on a guest, and a
// machine somebody owns carries its own place and no golden.
const deployedScripts = (): string[] => [openShimScript(CLOUD_PLACE), deployScript(CLOUD_PLACE, TOKEN, SUFFIX), daemonUnit(CLOUD_PLACE, GUEST_TARGET)];

describe("the daemon version names the content the host deploys", () => {
  it("holds the recorded sha, so a changed daemon cannot ship under a version no machine reads as behind", () => {
    const sha = daemonContentSha(DAEMON_TREE, deployedScripts());
    const ask = `what a deploy installs on a guest changed. Append ${sha} to DAEMON_CONTENTS in packages/protocol/src/index.ts, which cuts the next DAEMON_VERSION; leave it at v${DAEMON_VERSION} and every machine already running keeps the daemon it has`;
    // Where the line cannot be carried yet, the run says which sha the landing will ask for and goes on.
    if (sha !== DAEMON_CONTENT_SHA && !contentGateEnforced()) console.log(`::notice::${ask}`);
    else expect(sha, ask).toBe(DAEMON_CONTENT_SHA);
    // The version is the count of recorded contents, so the current one is a sha and not a placeholder.
    expect(DAEMON_CONTENT_SHA).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("what the recorded sha covers", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** The daemon tree as the sha reads it, copied: its crates, its two manifests, the libseccomp script and the
   * contract fixtures, and nothing of a build. */
  function copyOfDaemonTree(): string {
    dir = mkdtempSync(join(tmpdir(), "wsp-daemon-content-"));
    cpSync(join(DAEMON_TREE, "crates"), join(dir, "crates"), { recursive: true, filter: from => !from.includes("/target/") });
    for (const file of ["Cargo.toml", "Cargo.lock", "scripts/libseccomp-archive.sh"]) cpSync(join(DAEMON_TREE, file), join(dir, file));
    cpSync(join(DAEMON_TREE, "fixtures", "contract"), join(dir, "fixtures", "contract"), { recursive: true });
    return dir;
  }

  it("moves when a Rust source moves, when one is added, when a crate manifest moves and when the lock moves", () => {
    const tree = copyOfDaemonTree();
    // A copy hashes as the original does: the walk reads relative paths, so where the tree sits cannot move it.
    const base = daemonContentSha(tree, deployedScripts());
    expect(base).toBe(daemonContentSha(DAEMON_TREE, deployedScripts()));

    const main = join(tree, "crates", "wsp-daemon-bin", "src", "main.rs");
    writeFileSync(main, `${readFileSync(main, "utf8")}\nfn added() {}\n`);
    const edited = daemonContentSha(tree, deployedScripts());
    expect(edited).not.toBe(base);

    writeFileSync(join(tree, "crates", "wsp-daemon", "src", "added.rs"), "pub fn added() {}\n");
    const added = daemonContentSha(tree, deployedScripts());
    expect(added).not.toBe(edited);

    const manifest = join(tree, "crates", "wsp-daemon", "Cargo.toml");
    writeFileSync(manifest, `${readFileSync(manifest, "utf8")}\n[features]\nadded = []\n`);
    const featured = daemonContentSha(tree, deployedScripts());
    expect(featured).not.toBe(added);

    const lock = join(tree, "Cargo.lock");
    writeFileSync(lock, readFileSync(lock, "utf8").replace(/version = "(\d+)\.(\d+)\.(\d+)"/, (_m, a: string, b: string, c: string) => `version = "${a}.${b}.${Number(c) + 1}"`));
    expect(daemonContentSha(tree, deployedScripts())).not.toBe(featured);
  });

  it("stays where it is when a crate's tests/ folder moves, and moves for an inline case in the src beside it", () => {
    const tree = copyOfDaemonTree();
    const base = daemonContentSha(tree, deployedScripts());

    const existing = join(tree, "crates", "wsp-frames", "tests", "contract.rs");
    writeFileSync(existing, `${readFileSync(existing, "utf8")}\n#[test]\nfn added() {}\n`);
    expect(daemonContentSha(tree, deployedScripts())).toBe(base);

    writeFileSync(join(tree, "crates", "wsp-daemon", "tests", "added.rs"), "#[test]\nfn added() {}\n");
    expect(daemonContentSha(tree, deployedScripts())).toBe(base);

    // A file that ships carries its own cases, and the sha reads the file whole rather than parsing Rust.
    const src = join(tree, "crates", "wsp-frames", "src", "lib.rs");
    writeFileSync(src, `${readFileSync(src, "utf8")}\n#[cfg(test)]\nmod added {}\n`);
    expect(daemonContentSha(tree, deployedScripts())).not.toBe(base);
  });

  it("moves when a contract fixture moves, since the words and numbers the daemon answers with are pinned there", () => {
    const tree = copyOfDaemonTree();
    const base = daemonContentSha(tree, deployedScripts());
    const words = join(tree, "fixtures", "contract", "words.json");
    writeFileSync(words, JSON.stringify({ ...(JSON.parse(readFileSync(words, "utf8")) as Record<string, unknown>), added: "a sentence" }, null, 2));
    const worded = daemonContentSha(tree, deployedScripts());
    expect(worded).not.toBe(base);
    // A cap in the numbers moves it, in the fixture and in the Rust that mirrors it: both land on a guest.
    const numbers = join(tree, "fixtures", "contract", "numbers.json");
    writeFileSync(numbers, JSON.stringify({ ...(JSON.parse(readFileSync(numbers, "utf8")) as Record<string, unknown>), preAuthMaxBytes: 8192 }));
    const capped = daemonContentSha(tree, deployedScripts());
    expect(capped).not.toBe(worded);
    const rust = join(tree, "crates", "wsp-frames", "src", "numbers.rs");
    writeFileSync(rust, readFileSync(rust, "utf8").replace("pub const DEFAULT_PORT: u16 = 7070;", "pub const DEFAULT_PORT: u16 = 7071;"));
    expect(daemonContentSha(tree, deployedScripts())).not.toBe(capped);
  });

  it("moves when the libseccomp release the Linux builds link is pinned to moves", () => {
    const tree = copyOfDaemonTree();
    const base = daemonContentSha(tree, deployedScripts());
    const script = join(tree, "scripts", "libseccomp-archive.sh");
    writeFileSync(script, readFileSync(script, "utf8").replace("version=2.5.5", "version=2.5.6"));
    expect(daemonContentSha(tree, deployedScripts())).not.toBe(base);
  });

  it("moves when a script the deploy writes moves: the shim, the deploy, the unit", () => {
    const base = daemonContentSha(DAEMON_TREE, deployedScripts());
    const [shim, deploy, unit] = deployedScripts();
    expect(daemonContentSha(DAEMON_TREE, [`${shim}\n# changed`, deploy!, unit!])).not.toBe(base);
    expect(daemonContentSha(DAEMON_TREE, [shim!, `${deploy}\necho changed`, unit!])).not.toBe(base);
    expect(daemonContentSha(DAEMON_TREE, [shim!, deploy!, `${unit}\nNice=1\n`])).not.toBe(base);
  });

  it("ignores what is not on the guest or is the version itself: a note beside the sources, the version in its two files, and the token", () => {
    const tree = copyOfDaemonTree();
    const base = daemonContentSha(tree, deployedScripts());
    writeFileSync(join(tree, "crates", "wsp-daemon", "notes.md"), "not a source");
    expect(daemonContentSha(tree, deployedScripts())).toBe(base);
    // The version moves when a sha is appended here, and lands in both of these; a hash over it would chase itself.
    const numbers = join(tree, "fixtures", "contract", "numbers.json");
    writeFileSync(numbers, JSON.stringify({ ...(JSON.parse(readFileSync(numbers, "utf8")) as Record<string, unknown>), daemonVersion: 999 }));
    const rust = join(tree, "crates", "wsp-frames", "src", "numbers.rs");
    writeFileSync(rust, readFileSync(rust, "utf8").replace(/pub const DAEMON_VERSION: u32 = \d+;/, "pub const DAEMON_VERSION: u32 = 999;"));
    expect(daemonContentSha(tree, deployedScripts())).toBe(base);
    expect(daemonContentSha(DAEMON_TREE, [openShimScript(CLOUD_PLACE), deployScript(CLOUD_PLACE, "ddeeff", SUFFIX), daemonUnit(CLOUD_PLACE, GUEST_TARGET)])).not.toBe(daemonContentSha(DAEMON_TREE, deployedScripts()));
  });
});
