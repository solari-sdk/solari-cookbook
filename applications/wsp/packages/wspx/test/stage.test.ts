// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASSET_KINDS, REQUIRE_DAEMON_ENV, assetDir, assetProof, daemonTargetHere, stagedAsset, workspaceAsset } from "@wsp/host";
import { stageAssets, stagePaths } from "../scripts/stage.mjs";

const made: string[] = [];

/** A built tree the stage can read: the bundle, the repo's own files, and a source folder per asset. */
function sources(): { pkg: string; repo: string; from: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "wsp-stage-"));
  made.push(root);
  const paths = { pkg: join(root, "pkg"), repo: join(root, "repo"), from: { web: join(root, "web", "dist"), daemon: join(root, "daemon"), cli: join(root, "cli") } };
  mkdirSync(join(paths.pkg, "dist"), { recursive: true });
  writeFileSync(join(paths.pkg, "dist", "bin.js"), "#!/usr/bin/env node\n", { mode: 0o644 });
  for (const kind of ASSET_KINDS) {
    const proof = join(paths.from[kind]!, assetProof(kind));
    mkdirSync(dirname(proof), { recursive: true });
    writeFileSync(proof, "");
  }
  mkdirSync(join(paths.from["web"]!, "assets"), { recursive: true });
  writeFileSync(join(paths.from["web"]!, "assets", "app.js"), "export {};");
  // A release folder holds every target's binary; the one for this machine is the proof, the others ride along.
  mkdirSync(join(paths.from["daemon"]!, "x86_64-unknown-linux-musl"), { recursive: true });
  writeFileSync(join(paths.from["daemon"]!, "x86_64-unknown-linux-musl", "wsp-daemon"), "");
  // The published command is split across chunk files its bin imports by name, so its dist travels whole, and its
  // package.json with it, since the bin reads its version through that file.
  writeFileSync(join(paths.from["cli"]!, "dist", "chunk-1.js"), "export const y = 2;");
  writeFileSync(join(paths.from["cli"]!, "package.json"), '{"name":"@zingzy/wsp","version":"9.9.9"}');
  writeFileSync(join(paths.from["cli"]!, "tsup.config.ts"), "// never travels");
  mkdirSync(paths.repo, { recursive: true });
  writeFileSync(join(paths.repo, "LICENSE"), "AGPL-3.0-only");
  writeFileSync(join(paths.repo, "README.md"), "# wsp");
  return paths;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("staging the published package", () => {
  it("lays every asset where the host reads it back", () => {
    const paths = sources();
    stageAssets(paths);
    const dist = join(paths.pkg, "dist");
    for (const kind of ASSET_KINDS) {
      expect(assetDir(kind, dist)).toBe(stagedAsset(paths.pkg, kind));
      expect(existsSync(join(assetDir(kind, dist), assetProof(kind)))).toBe(true);
    }
    expect(existsSync(join(stagedAsset(paths.pkg, "web"), "assets", "app.js"))).toBe(true);
    // Every target's binary travels, whatever machine staged the package: the command deploys the Linux ones.
    expect(existsSync(join(stagedAsset(paths.pkg, "daemon"), "x86_64-unknown-linux-musl", "wsp-daemon"))).toBe(true);
    // The wsp command rides in the package too, as npm lays it out: it is what a machine's daemon bundle carries to
    // the guest, and the bin reads its version through the package.json beside its dist.
    expect(existsSync(join(stagedAsset(paths.pkg, "cli"), "dist", "chunk-1.js"))).toBe(true);
    expect(JSON.parse(readFileSync(join(stagedAsset(paths.pkg, "cli"), "package.json"), "utf8"))).toMatchObject({ version: "9.9.9" });
  });

  it("takes only what a guest runs out of the command's folder", () => {
    const paths = sources();
    stageAssets(paths);
    expect(existsSync(join(stagedAsset(paths.pkg, "cli"), "tsup.config.ts"))).toBe(false);
  });

  it("copies the licence and the readme in, because npm publishes only the package's own", () => {
    const paths = sources();
    stageAssets(paths);
    expect(readFileSync(join(paths.pkg, "LICENSE"), "utf8")).toBe("AGPL-3.0-only");
    expect(readFileSync(join(paths.pkg, "README.md"), "utf8")).toBe("# wsp");
  });

  it("leaves the command executable", () => {
    const paths = sources();
    stageAssets(paths);
    expect(statSync(join(paths.pkg, "dist", "bin.js")).mode & 0o111).toBe(0o111);
  });

  it("drops what an earlier stage left behind", () => {
    const paths = sources();
    stageAssets(paths);
    const stale = join(stagedAsset(paths.pkg, "web"), "gone.js");
    writeFileSync(stale, "export {};");
    stageAssets(paths);
    expect(existsSync(stale)).toBe(false);
  });

  it("names any asset that was never built instead of packing a broken command, where the release requires them all", () => {
    for (const kind of ASSET_KINDS) {
      const paths = sources();
      rmSync(join(paths.from[kind]!, assetProof(kind)));
      expect(() => stageAssets(paths, { [REQUIRE_DAEMON_ENV]: "1" })).toThrow(new RegExp(`missing: .*${assetProof(kind).replace(".", "\\.")}$`));
    }
  });

  // The binary this machine runs is what proves the daemon folder: without it the host on this machine could
  // serve no local workspace, however many other targets' binaries are there. The release is where the folder is
  // filled before the build, so the release is where a missing one fails it.
  it("where the release stages the package, refuses a daemon folder without this machine's own binary, whatever else is in it", () => {
    const paths = sources();
    expect(assetProof("daemon")).toBe(`${daemonTargetHere()!.triple}/wsp-daemon`);
    rmSync(join(paths.from["daemon"]!, assetProof("daemon")));
    mkdirSync(join(paths.from["daemon"]!, "some-other-triple"), { recursive: true });
    writeFileSync(join(paths.from["daemon"]!, "some-other-triple", "wsp-daemon"), "");
    expect(() => stageAssets(paths, { [REQUIRE_DAEMON_ENV]: "1" })).toThrow(/wsp-daemon binary missing/);
    expect(existsSync(stagedAsset(paths.pkg, "daemon"))).toBe(false);
  });

  // No node build fills the daemon folder: a cargo build or a release's artifacts do. A checkout without either is a
  // developer's or a gate's, and the command it builds carries no daemon rather than not building at all.
  it("anywhere else, skips a daemon folder that was never filled, says so once, and stages everything else", () => {
    const paths = sources();
    rmSync(join(paths.from["daemon"]!, assetProof("daemon")));
    const said: string[] = [];
    stageAssets(paths, {}, line => said.push(line));
    expect(said).toEqual([`wsp-daemon binary not staged: ${join(paths.from["daemon"]!, assetProof("daemon"))} is missing, so the command carries none; packages/wspx/scripts/daemon-binary.mjs places one`]);
    expect(existsSync(stagedAsset(paths.pkg, "daemon"))).toBe(false);
    for (const kind of ASSET_KINDS.filter(k => k !== "daemon")) expect(existsSync(join(stagedAsset(paths.pkg, kind), assetProof(kind)))).toBe(true);
    // With the binary there, the same stage takes it and says nothing.
    const filled = sources();
    const quiet: string[] = [];
    stageAssets(filled, {}, line => quiet.push(line));
    expect(quiet).toEqual([]);
    expect(existsSync(join(stagedAsset(filled.pkg, "daemon"), assetProof("daemon")))).toBe(true);
  });

  it("takes every asset's source from the table rather than resolving its own", () => {
    const paths = stagePaths();
    expect(existsSync(join(paths.repo, "pnpm-workspace.yaml"))).toBe(true);
    for (const kind of ASSET_KINDS) expect(paths.from[kind]).toBe(workspaceAsset(kind));
  });
});
