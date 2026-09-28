// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ASSET_KINDS, DAEMON_TARGETS, daemonArtifactName, workspaceAsset } from "@wsp/host";
import { bundleEnv, bundleNames, STABLE_NAMES } from "../scripts/bundles.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const workflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");
const desktopPackage = JSON.parse(readFileSync(join(repo, "apps", "desktop", "package.json"), "utf8")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
const desktopScripts = desktopPackage.scripts;
const builderConfig = readFileSync(join(repo, "apps", "desktop", "electron-builder.yml"), "utf8");
const macJob = workflow.slice(workflow.indexOf("\n  mac:\n"), workflow.indexOf("\n  linux:\n"));
const linuxJob = workflow.slice(workflow.indexOf("\n  linux:\n"), workflow.indexOf("\n  npm:\n"));
const npmJob = workflow.slice(workflow.indexOf("\n  npm:\n"), workflow.indexOf("\n  publish:\n"));
const publishJob = workflow.slice(workflow.indexOf("\n  publish:\n"));
const daemonJob = workflow.slice(workflow.indexOf("\n  daemon:\n"), workflow.indexOf("\n  draft:\n"));
/** The names bundle-env.mjs writes into a job's environment, which is where every job reads them from. */
const envNames = bundleEnv("0.1.5")
  .trim()
  .split("\n")
  .map(line => line.slice(0, line.indexOf("=")));
/** What signs and notarizes the mac bundles, by the names electron-builder reads them under. */
const SIGNING_SECRETS = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The shell one step of a job runs, taken out of the block the runner hands to bash. */
function stepScript(job: string, name: string): string {
  const at = job.indexOf(`- name: ${name}\n`);
  expect(at, name).toBeGreaterThan(-1);
  const body = job.slice(job.indexOf("run: |\n", at) + "run: |\n".length).split("\n");
  const lines: string[] = [];
  for (const line of body) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
    lines.push(line.slice(10));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A gh of its own answering the read of the release served as latest, and recording every `gh release` call so a
 * case reads whether the draft was ever flipped. */
function stubGh(answer: string): string {
  return `#!/bin/sh\ncase "$1 $2" in\n  "api repos/Zingzy/wsp/releases/latest") ${answer} ;;\nesac\ncase "$1" in release) echo "$*" >> edits ;; esac\n`;
}

/** That step as the runner runs it, `bash -e` with that gh first on PATH, in a checkout of its own carrying the
 * scripts the step calls, so nothing is written into this one. They are copied and not linked: node reads a main
 * module through its real path, and a script reached by a link would not know it was run as one. */
function runStep(script: string, gh: string): { status: number; said: string; edits: string } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-publish-"));
  made.push(dir);
  writeFileSync(join(dir, "gh"), gh);
  chmodSync(join(dir, "gh"), 0o755);
  cpSync(join(repo, "packages", "wspx", "scripts"), join(dir, "packages", "wspx", "scripts"), { recursive: true });
  mkdirSync(join(dir, "packages", "protocol", "src"), { recursive: true });
  cpSync(join(repo, "packages", "protocol", "src", "semver.mjs"), join(dir, "packages", "protocol", "src", "semver.mjs"));
  writeFileSync(join(dir, "step.sh"), script);
  const ran = spawnSync("bash", ["-e", "step.sh"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}`, GITHUB_REF_NAME: "v0.3.0", GITHUB_REPOSITORY: "Zingzy/wsp" },
  });
  const edits = join(dir, "edits");
  return { status: ran.status ?? -1, said: `${ran.stdout}${ran.stderr}`, edits: existsSync(edits) ? readFileSync(edits, "utf8") : "" };
}

describe("the release workflow", () => {
  it("runs on a pushed release tag, and by hand as a dry run with no box to untick", () => {
    expect(workflow).toContain('on:\n  push:\n    tags:\n      - "v*"\n');
    expect(workflow).not.toContain("branches:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("schedule:");
    // A run started by hand publishes nothing whatever ref it runs on, so there is no input to read.
    expect(workflow).toContain("workflow_dispatch:\n");
    expect(workflow).not.toContain("dry_run");
    expect(workflow).not.toContain("inputs.");
    expect(workflow).toContain("if: ${{ github.event_name == 'push' && github.ref_type == 'tag' }}");
    expect(npmJob).toContain("name: Publish\n        if: ${{ github.event_name == 'push' }}");
    expect(npmJob).toContain("needs.daemon.result == 'success' && (github.event_name != 'push' || needs.draft.result == 'success')");
  });

  it("refuses a tag off main's own line before it drafts anything", () => {
    const draftJob = workflow.slice(workflow.indexOf("\n  draft:\n"), workflow.indexOf("\n  mac:\n"));
    expect(draftJob).toContain("git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main");
    expect(draftJob).toContain('node packages/wspx/scripts/tag-version.mjs "$GITHUB_REF_NAME"');
    // Every job that drafts, builds, publishes or flips waits on that check.
    for (const job of [macJob, linuxJob]) expect(job).toContain("needs: [draft, daemon]");
    expect(publishJob).toContain("needs: [draft, mac, linux, npm]");
  });

  it("attaches the binaries and decides latest from the job that flips the draft, not from the one that publishes", () => {
    // The job that can mint the identity token writes nothing here, so the attach moved to the job that flips.
    expect(npmJob).not.toContain("gh release upload");
    expect(publishJob).toContain("name: Attach the binaries to the draft");
    expect(publishJob).toContain('gh release upload "$GITHUB_REF_NAME" daemon-bins/*/wsp-daemon-* --clobber');
    expect(publishJob).toContain("pattern: wsp-daemon-*");
    expect(publishJob).toContain("- uses: actions/checkout@");
    expect(publishJob).toContain('gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name');
    expect(publishJob).toContain('node packages/wspx/scripts/latest-flag.mjs "$GITHUB_REF_NAME" "$current"');
    expect(publishJob).toContain('gh release edit "$GITHUB_REF_NAME" --draft=false $flag');
    expect(publishJob).not.toContain("--latest");
  });

  it("reads no release served as latest off the 404 and not off an empty answer, and publishes as latest", () => {
    // gh writes the error body to stdout and exits 1, so an empty answer is never what a repository with no latest
    // release looks like.
    const notFound = `printf '{"message":"Not Found"}\\n'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1`;
    const ran = runStep(stepScript(publishJob, "Turn the draft into a release, latest where its version says so"), stubGh(notFound));
    expect(ran.status, ran.said).toBe(0);
    expect(ran.said).toContain("(none): --latest");
    expect(ran.edits.trim()).toBe("release edit v0.3.0 --draft=false --latest");
  });

  it("fails on any other failure of that read and leaves the release a draft", () => {
    const badGateway = `printf '{"message":"Bad gateway"}\\n'; echo 'gh: Bad gateway (HTTP 502)' >&2; exit 1`;
    const ran = runStep(stepScript(publishJob, "Turn the draft into a release, latest where its version says so"), stubGh(badGateway));
    expect(ran.status).not.toBe(0);
    expect(ran.said).toContain("HTTP 502");
    // The step stops on the read that failed and says so, rather than handing the error body on and failing later
    // under a sentence about a tag nobody named.
    expect(ran.said).not.toContain("not a release tag");
    expect(ran.edits).toBe("");
  });

  it("reads the tag it is served and hands it to the flag script", () => {
    const ran = runStep(stepScript(publishJob, "Turn the draft into a release, latest where its version says so"), stubGh("echo v0.2.0"));
    expect(ran.status, ran.said).toBe(0);
    expect(ran.edits.trim()).toBe("release edit v0.3.0 --draft=false --latest");
    expect(ran.said).toContain("v0.3.0 against the release served as latest (v0.2.0): --latest");
  });

  it("builds one static daemon per target the host names, uploads each under the artifact name the host spells, and places all of them before every build", () => {
    // Each Linux binary is built natively on its own chip's runner, so the static link needs no cross toolchain.
    const runners: Record<string, string> = { "x86_64-unknown-linux-musl": "ubuntu-24.04", "aarch64-unknown-linux-musl": "ubuntu-24.04-arm", "aarch64-apple-darwin": "macos-14", "x86_64-apple-darwin": "macos-14" };
    for (const target of DAEMON_TARGETS) {
      const row = daemonJob.slice(daemonJob.indexOf(`- target: ${target.triple}\n`));
      expect(row.length).toBeGreaterThan(0);
      expect(/os: (\S+)/.exec(row)![1]).toBe(runners[target.triple]);
    }
    expect(daemonJob).toContain(`name: ${daemonArtifactName("${{ matrix.target }}")}`);
    expect(daemonJob).toContain("./scripts/libseccomp-archive.sh musl");
    expect(daemonJob).toContain('LIBSECCOMP_LIB_PATH="$PWD/target/libseccomp/musl" cargo build --locked --release --target "$TARGET" -p wsp-daemon-bin');
    expect(daemonJob).not.toContain("zig");
    // Every job that builds the command or the app reads the binaries back first, through the one script.
    for (const job of [macJob, linuxJob, npmJob]) {
      expect(job).toContain("pattern: wsp-daemon-*");
      expect(job).toContain("node packages/wspx/scripts/daemon-binary.mjs --from-artifacts daemon-bins");
      expect(job).toContain("needs: [draft, daemon]");
    }
    expect(npmJob).toContain("node packages/wspx/scripts/daemon-binary.mjs --check");
    // The release is the one place the daemon binaries are required of a build: each job that builds sets the
    // variable the stage reads, so a missing binary fails there and a checkout without one still builds.
    for (const job of [macJob, linuxJob, npmJob]) expect(job).toContain('WSP_REQUIRE_DAEMON: "1"');
    expect(workflow.split('WSP_REQUIRE_DAEMON: "1"').length - 1).toBe(3);
    expect(existsSync(join(repo, "packages/wspx/scripts/daemon-binary.mjs"))).toBe(true);
  });

  it("publishes the command line package from the runner through trusted publishing, and holds no npm token", () => {
    expect(workflow).toContain("npm publish --provenance --access public");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("NPM_TOKEN");
    // setup-node with a registry-url writes an .npmrc that reads NODE_AUTH_TOKEN, so that name is the other road a
    // credential could arrive by and neither is allowed to appear.
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("pnpm release");
    // npm's own latest dist-tag would move under the identity token, so the version it installs is exact.
    expect(npmJob).toMatch(/npm install -g npm@\d+\.\d+\.\d+\n/);
    expect(workflow).toContain("--draft");
    expect(workflow).toContain("--draft=false");
  });

  it("asks the scripts in the repo for the version, the notes and every asset name", () => {
    for (const script of ["packages/wspx/scripts/tag-version.mjs", "packages/wspx/scripts/release-notes.mjs", "packages/wspx/scripts/bundle-env.mjs", "packages/wspx/scripts/latest-flag.mjs"]) {
      expect(workflow).toContain(`node ${script}`);
      expect(existsSync(join(repo, script))).toBe(true);
    }
  });

  it("builds each platform through the script apps/desktop owns", () => {
    for (const step of ["run build:mac", "run build:linux"]) expect(workflow).toContain(`pnpm --filter @wsp/desktop ${step}`);
    // The screen smoke measures a real Mac's window and fails on a hosted runner's display; the packaged trees are
    // checked there instead, and the smoke stays in the merge gate on a Mac.
    expect(workflow).not.toContain("pnpm --filter @wsp/desktop smoke");
    expect(workflow).toContain("test/signing.test.ts");
    expect(workflow).not.toContain("pty-native");
    expect(desktopScripts["build:mac"]).toContain("--mac");
    expect(desktopScripts["build:linux"]).toContain("--linux");
    // The plain build packages the machine it runs on and the workflow's two jobs are what make both platforms.
    expect(desktopScripts["build"]).toBe("pnpm run build:deps && pnpm run build:app && electron-builder --config electron-builder.yml --publish never");
  });

  it("builds every package the app's staging copies from in build:deps, the only build the release runs first", () => {
    expect(desktopScripts["build:deps"]).toBe('pnpm --filter "@wsp/desktop^..." build');
    for (const kind of ASSET_KINDS) {
      let dir = workspaceAsset(kind);
      while (!existsSync(join(dir, "package.json"))) {
        if (dirname(dir) === dir) throw new Error(`staged asset ${kind} sits in no package`);
        dir = dirname(dir);
      }
      const { name } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string };
      expect(desktopPackage.devDependencies[name], `${kind} asset from ${name}`).toBe("workspace:*");
    }
  });

  it("makes one mac bundle for both chips, so no download depends on reading the chip", () => {
    expect(desktopScripts["build:mac"]).not.toMatch(/--(arm64|x64)\b/);
    expect(/^mac:\n((?: .*\n)+)/m.exec(builderConfig)?.[1]).toContain("arch: [universal]");
    expect(macJob).not.toContain("mac-arm64");
    expect(macJob).not.toContain("dist/mac");
  });

  it("hands the signing secrets by name to the step that builds, tells the step that checks whether one signed, and no value anywhere", () => {
    const [header, ...steps] = macJob.split("\n      - ");
    const secretOf = (name: string) => `${name}: \${{ secrets.${name} }}`;
    const build = steps.find(step => step.startsWith("name: Build the bundles"));
    const check = steps.find(step => step.startsWith("name: Check the packaged trees"));
    for (const name of SIGNING_SECRETS) {
      expect(build).toContain(secretOf(name));
      const assignments = workflow.split("\n").filter(line => line.includes(`${name}:`)).map(line => line.trim());
      expect(new Set(assignments)).toEqual(new Set([secretOf(name)]));
    }
    // The check step reads whether an identity signed and never the certificate itself, so no test's environment
    // carries its bytes.
    expect(check).toContain("WSP_SIGNED: ${{ secrets.CSC_LINK != '' && '1' || '' }}");
    for (const name of SIGNING_SECRETS) expect(check).not.toContain(secretOf(name));
    expect(check).not.toMatch(/secrets\.(CSC_KEY|APPLE)/);
    // The test that reads whether an identity signed reads the name this step sets, so the two move as one.
    const signing = readFileSync(join(repo, "apps", "desktop", "test", "signing.test.ts"), "utf8");
    expect(signing).toContain("WSP_SIGNED");
    expect(signing).not.toContain("CSC_LINK");
    for (const part of [header, ...steps.filter(step => step !== build && step !== check)]) expect(part).not.toMatch(/secrets\.(CSC|APPLE)/);
    expect(workflow).not.toContain("Developer ID Application:");
  });

  it("unsets an empty CSC_LINK before the build, which would take it for a certificate", () => {
    expect(workflow).toContain('if [ -z "$CSC_LINK" ]; then unset CSC_LINK; fi\n          pnpm --filter @wsp/desktop run build:mac');
  });

  it("drafts the notes without the right-click Open paragraph once the certificate signs the bundles", () => {
    expect(workflow).toContain(`release-notes.mjs "$GITHUB_REF_NAME" \${{ secrets.CSC_LINK != '' && '--signed' || '' }} > notes.md`);
  });

  it("takes every asset name from the one formatter and spells none of its own", () => {
    for (const job of [macJob, linuxJob]) expect(job).toContain('node packages/wspx/scripts/bundle-env.mjs "$VERSION" >> "$GITHUB_ENV"');
    for (const name of [...Object.values(bundleNames("$VERSION")), ...Object.values(STABLE_NAMES)]) expect(workflow).not.toContain(name);
    expect(workflow).not.toMatch(/wsp-[^"\s]*\.(dmg|AppImage|zip)/);
    for (const name of envNames) expect(workflow).toContain(`$${name}`);
  });

  it("uploads each bundle under the release's own name and under the name a link can hold", () => {
    expect(macJob).toContain('gh release upload "$GITHUB_REF_NAME" "$MAC_DMG" "$MAC_STABLE" --clobber');
    expect(macJob).toContain('cp "$MAC_DMG" "$MAC_STABLE"');
    expect(linuxJob).toContain('gh release upload "$GITHUB_REF_NAME" "$APPIMAGE" "$APPIMAGE_STABLE" --clobber');
    expect(linuxJob).toContain('cp "$APPIMAGE" "$APPIMAGE_STABLE"');
  });

  it("never lets the packager upload a release of its own", () => {
    for (const name of ["build:mac", "build:linux"]) expect(desktopScripts[name]).toContain("--publish never");
  });
});
