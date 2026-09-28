// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { APT_INDEX, BASE_FLOOR, CURL_NET, ROAD_STEPS, UV_INSTALL, installAfter } from "@wsp/catalog";
import { PRELUDE } from "../src/dotfiles-presets.js";
import { ALREADY_ON_MACHINE, baseInstalls, baseVersionsCmd, carriedByImage, installBase, parseVersions, versionsLine } from "../src/golden-base.js";
import { TOOLS_PATH } from "../src/golden-import.js";
import { FREE_KB_CMD, guardedRoad, reasonOf, roadLimitS } from "../src/golden-tools.js";
import type { ExecResult, Machine } from "../src/machine.js";
import type { GoldenStage } from "../src/golden.js";

const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
const mb = (n: number) => String(n * 1024);

/** A guest that answers df from `free`, runs every script with `answer`, and records both. `onImage` is what the
 * floor's version read prints before anything installs, which is the image as the provider ships it: bare unless a
 * test says the image already carries something. */
function guest(answer: (script: string) => ExecResult | undefined, free: () => string = () => mb(3000), onImage = "") {
  const ran: string[] = [];
  const cmds: string[] = [];
  let reads = 0;
  const machine = {
    id: "m1",
    kind: "sandbox",
    streamUrl: undefined,
    exec: async (cmd: string) => {
      cmds.push(cmd);
      if (cmd === FREE_KB_CMD) return { exitCode: 0, stdout: `${free()}\n`, stderr: "" };
      if (cmd === baseVersionsCmd(TOOLS_PATH) && reads++ === 0) return { exitCode: 0, stdout: onImage, stderr: "" };
      return answer(cmd) ?? ok;
    },
    run: async (script: string) => {
      ran.push(script);
      return answer(script) ?? ok;
    },
  } as unknown as Machine;
  return { machine, ran, cmds };
}

function recorder() {
  const stages: string[] = [];
  return { stages, stage: (s: GoldenStage, d?: string) => void stages.push(d === undefined ? s : `${s}:${d}`) };
}

const VERSIONS_OUT = [
  "VERSION uv: uv 0.12.9",
  "VERSION python3: Python 3.12.13",
  "VERSION git: git version 2.43.0",
  "VERSION jq: jq-1.7.1",
  "VERSION rg: ripgrep 14.1.0 (rev 4649aa9700)",
  "VERSION curl: curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0",
  "VERSION cc: cc (Debian 12.2.0-14) 12.2.0",
  "",
].join("\n");

describe("the base floor's plan", () => {
  it("is every floor entry by its catalog road, in order, each waiting on what it needs", () => {
    const plan = baseInstalls();
    expect(plan.map(t => [t.id, t.manager, t.after, t.bin])).toEqual([
      ["base/login-path", "script", undefined, undefined],
      // curl leads the floor: the roads below that fetch a release type it, and a container image ships none.
      ["base/apt-index", "apt", undefined, undefined],
      ["base/curl", "apt", "base/apt-index", "curl"],
      ["base/uv", "script", "base/curl", "uv"],
      ["base/python", "script", "base/uv", "python3"],
      ["base/git", "apt", "base/apt-index", "git"],
      ["base/jq", "apt", "base/apt-index", "jq"],
      ["base/ripgrep", "apt", "base/apt-index", "rg"],
      ["base/build-essential", "apt", "base/apt-index", "cc"],
      ["base/fd", "script", "base/apt-index", "fd"],
      ["base/sqlite3", "apt", "base/apt-index", "sqlite3"],
      ["base/wget", "apt", "base/apt-index", "wget"],
      ["base/zip", "apt", "base/apt-index", "zip"],
      ["base/xz", "apt", "base/apt-index", "xz"],
      ["base/rsync", "apt", "base/apt-index", "rsync"],
    ]);
    expect(plan.map(t => t.label)).toEqual(["login shell PATH", "apt index", "curl", "uv", "Python 3.12", "git", "jq", "ripgrep", "C toolchain with cmake and ninja", "fd", "sqlite3", "wget", "zip and unzip", "xz", "rsync"]);
    // Node is not on the floor: a recipe row that runs on it brings it in the tools stage instead.
    expect(plan.some(t => t.cmd.includes("nodejs.org/dist"))).toBe(false);
    expect(BASE_FLOOR.map(e => `base/${e.id}`)).toEqual(plan.filter(t => t.bin !== undefined).map(t => t.id));
  });

  it("writes the login shell's PATH before the floor, on every golden, so a thread's terminal finds what the stages install", () => {
    const step = baseInstalls().find(t => t.id === "base/login-path")!;
    expect(step.cmd).toContain(`printf '%s\\n' 'export PATH=${TOOLS_PATH} PNPM_HOME=/root/.local/share/pnpm' > /etc/profile.d/wsp-golden.sh`);
    expect(step.shown).toBe("the tools PATH in /etc/profile.d/wsp-golden.sh");
    // cargo comes by rustup on a golden with no Homebrew formula at all, and a login shell still finds it.
    expect(TOOLS_PATH).toContain("/root/.cargo/bin");
  });

  it("every step, the apt index included, names one line a person reads for what it runs, so the Build screen's step row is one row", () => {
    for (const t of baseInstalls()) {
      expect(t.shown, t.id).toBeDefined();
      expect(t.shown, t.id).not.toContain("\n");
    }
    const shown = (id: string) => baseInstalls().find(t => t.id === id)!.shown;
    expect(shown("base/apt-index")).toBe("apt-get update");
    expect(shown("base/git")).toBe("apt-get install git");
    expect(shown("base/uv")).toMatch(/^if ! command -v uv >\/dev\/null 2>&1; then; .*; fi$/);
  });

  it("every step runs under set -e with a home and the tools PATH, and each road is the catalog's pinned one", () => {
    const cmd = (id: string) => baseInstalls().find(t => t.id === id)!.cmd;
    for (const t of baseInstalls()) {
      expect(t.cmd, t.id).toMatch(/^set -euo pipefail\nexport HOME=/);
      expect(t.cmd, t.id).toMatch(/\nexport PATH=\/root\/\.local\/bin:\/usr\/local\/sbin:\/usr\/local\/bin:/);
      expect(t.cmd, t.id).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
    }
    expect(cmd("base/uv")).toContain("astral-sh/uv/releases/download/");
    expect(cmd("base/uv")).toContain("sha256sum -c");
    expect(cmd("base/python")).toMatch(/\nuv python install 3\.12\nln -sfn "\$\(uv python find --managed-python 3\.12\)" \/usr\/local\/bin\/python3$/);
    expect(cmd("base/apt-index")).toMatch(/\nexport DEBIAN_FRONTEND=noninteractive\napt-get update -qq$/);
    expect(cmd("base/jq")).toMatch(/\nexport DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq jq$/);
    // The one floor row whose road is a script over apt: Debian ships the binary under another name and the step
    // puts the name agents type on PATH.
    expect(cmd("base/fd")).toMatch(/\nexport DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq fd-find\nln -sfn \/usr\/bin\/fdfind \/usr\/local\/bin\/fd$/);
  });
});

describe("a download that fails", () => {
  it("every base step that downloads runs under the one curl function, which fails loud on an HTTP error, and types no flags of its own", () => {
    const downloads = baseInstalls().filter(t => /\bcurl +-/.test(t.cmd));
    expect(downloads.map(t => t.id)).toEqual(["base/uv", "base/python"]);
    for (const t of downloads) {
      const run = guardedRoad(t.manager, t.cmd);
      expect(run, t.id).toContain(CURL_NET);
      expect(CURL_NET).toContain("--fail --silent --show-error --location");
      expect(run.indexOf(CURL_NET), t.id).toBeLessThan(run.indexOf("curl -o"));
      expect(t.cmd, t.id).not.toMatch(/\bcurl +-[A-Za-z]*[fsSL]\b/);
    }
  });

  it("leaves curl's own error as the step's reason: the uv script under bash, with a curl on PATH that fails the way a 404 does", () => {
    // uname answers x86_64 so the script reaches its download on this Mac; the curl stand-in fails as curl 7.88 does on a 404.
    const dir = mkdtempSync(join(tmpdir(), "wsp-base-curl-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "uname"), "#!/bin/sh\necho x86_64\n", { mode: 0o755 });
    writeFileSync(join(dir, "curl"), '#!/bin/sh\necho "curl: (22) The requested URL returned error: 404" >&2\nexit 22\n', { mode: 0o755 });
    const script = [PRELUDE, ...ROAD_STEPS.script.env, UV_INSTALL].join("\n");
    const res = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin` } });
    expect(res.status).toBe(22);
    expect(reasonOf({ exitCode: res.status ?? -1, stdout: res.stdout, stderr: res.stderr }, roadLimitS("script"))).toBe("curl: (22) The requested URL returned error: 404");
  });
});

describe("the versions read", () => {
  const BASE_VERSIONS_CMD = baseVersionsCmd(TOOLS_PATH);

  it("asks each floor command for its version on the tools PATH, unzip with zip, and nothing of the node that left it", () => {
    const first = String.raw`grep -m1 -E '[0-9]+\.[0-9]+'`;
    expect(BASE_VERSIONS_CMD).toMatch(/^export PATH=\/root\/\.local\/bin:/);
    expect(BASE_VERSIONS_CMD).not.toContain("VERSION node:");
    expect(BASE_VERSIONS_CMD).not.toContain("VERSION npm:");
    expect(BASE_VERSIONS_CMD).toContain(`echo "VERSION python3: $(python3 --version 2>/dev/null | ${first})"`);
    expect(BASE_VERSIONS_CMD).toContain(`echo "VERSION rg: $(rg --version 2>/dev/null | ${first})"`);
    expect(BASE_VERSIONS_CMD).toContain(`echo "VERSION unzip: $(unzip -v 2>/dev/null | ${first})"`);
    expect(BASE_VERSIONS_CMD).toContain(`echo "VERSION git: $(git --version 2>/dev/null | ${first})"`);
    expect(BASE_VERSIONS_CMD.split("\n").filter((l: string) => l.startsWith("echo \"VERSION"))).toHaveLength(16);
  });

  it("keeps the first line of a read that carries a version, so zip reads carried and the floor has no apt index to run", () => {
    // Every floor command answering under a real bash, zip with the two lines it really prints on Ubuntu: its
    // version is on the second, behind a copyright line with no version number on it at all.
    const dir = mkdtempSync(join(tmpdir(), "wsp-floor-read-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    for (const e of BASE_FLOOR) {
      for (const c of [{ bin: e.bin, version: e.major === undefined ? "9.9.9" : `${e.major.version}.0` }, ...(e.brings ?? []).map(b => ({ bin: b.bin, version: "9.9.9" }))]) {
        writeFileSync(join(dir, c.bin), `#!/bin/sh\necho "${c.bin} ${c.version}"\n`, { mode: 0o755 });
      }
    }
    writeFileSync(join(dir, "zip"), ["#!/bin/sh", "echo \"Copyright (c) 1990-2008 Info-ZIP - Type 'zip \\\"-L\\\"' for software license.\"", "echo 'This is Zip 3.0 (July 5th 2008), by Info-ZIP.'", ""].join("\n"), { mode: 0o755 });
    // The scratch folder goes ahead of the tools PATH the read exports, which itself carries /usr/bin: this Mac's
    // own zip would answer otherwise, and what is under test is the read, not this machine.
    const res = spawnSync("bash", ["-c", BASE_VERSIONS_CMD.replace(TOOLS_PATH, `${dir}:${TOOLS_PATH}`)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(res.status).toBe(0);
    const versions = parseVersions(res.stdout);
    expect(versions).toContainEqual({ name: "zip", version: "3.0" });

    // With every row of the floor on the machine, nothing of it installs and no apt index is read for it: the
    // index runs before the first row that waits on it and no row is left to wait.
    const carried = carriedByImage(versions);
    expect([...carried].sort()).toEqual(BASE_FLOOR.map(e => e.id).sort());
    expect(baseInstalls(carried).map(t => t.id)).toEqual(["base/login-path"]);
  });

  it("keeps the version number out of each tool's own wording, and leaves out a command that printed nothing", () => {
    expect(parseVersions(VERSIONS_OUT)).toEqual([
      { name: "uv", version: "0.12.9" },
      { name: "python3", version: "3.12.13" },
      { name: "git", version: "2.43.0" },
      { name: "jq", version: "1.7.1" },
      { name: "rg", version: "14.1.0" },
      { name: "curl", version: "8.5.0" },
      { name: "cc", version: "12.2.0" },
    ]);
    expect(parseVersions("VERSION node: v22.23.2\nVERSION zip: \nVERSION rg: no digits here\nnoise\n")).toEqual([{ name: "node", version: "22.23.2" }]);
    expect(parseVersions("")).toEqual([]);
  });

  it("the stage line names each version with what its install cost, and a floor entry that did not land by its reason", () => {
    const versions = parseVersions(VERSIONS_OUT).filter(v => v.name !== "cc");
    const line = versionsLine(versions, [
      { id: "base/uv", label: "uv", outcome: "installed", bytes: 42 * 1024 * 1024 },
      { id: "base/python", label: "Python 3.12", outcome: "installed", bytes: 70 * 1024 * 1024 },
      { id: "base/apt-index", label: "apt index", outcome: "installed" },
      { id: "base/git", label: "git", outcome: "installed", bytes: 0 },
      { id: "base/jq", label: "jq", outcome: "installed", bytes: 2 * 1024 * 1024 },
      { id: "base/ripgrep", label: "ripgrep", outcome: "installed", bytes: 6 * 1024 * 1024 },
      { id: "base/curl", label: "curl", outcome: "installed", bytes: 0 },
      { id: "base/fd", label: "fd", outcome: "failed", note: "E: Unable to locate package fd-find" },
    ]);
    expect(line).toBe("uv 0.12.9 (42 MB), python3 3.12.13 (70 MB), git 2.43.0, jq 1.7.1 (2 MB), rg 14.1.0 (6 MB), curl 8.5.0; fd failed (E: Unable to locate package fd-find)");
    expect(versionsLine([], [])).toBe("");
  });
});

describe("installBase", () => {
  it("runs the floor under the base stage, reads the versions once after, and its line carries them with the sizes df saw", async () => {
    let free = 3000;
    const g = guest(script => {
      if (script.includes("nodejs.org/dist")) {
        free -= 250;
        return { exitCode: 0, stdout: "NODE_HAVE v18.20.4\nNODE_INSTALLED v22.23.2\n", stderr: "" };
      }
      if (script.includes("apt-get install -y -qq build-essential cmake ninja-build")) {
        free -= 400;
        return ok;
      }
      if (script.startsWith("export PATH=") && script.includes("VERSION curl:")) return { exitCode: 0, stdout: VERSIONS_OUT, stderr: "" };
      return undefined;
    }, () => mb(free));
    const { stages, stage } = recorder();
    const out = await installBase(g.machine, stage);
    expect(stages[0]).toBe("deploying-daemon:login shell PATH (1/15)");
    expect(stages).toContain("deploying-daemon:uv (4/15)");
    expect(stages).toContain("deploying-daemon:C toolchain with cmake and ninja (9/15)");
    expect(stages).toContain("deploying-daemon:rsync (15/15)");
    expect(stages.every(s => s.startsWith("deploying-daemon"))).toBe(true);
    expect(out.tools.map(t => [t.id, t.outcome, t.bytes])).toEqual([
      ["base/login-path", "installed", 0],
      ["base/apt-index", "installed", 0],
      ["base/curl", "installed", 0],
      ["base/uv", "installed", 0],
      ["base/python", "installed", 0],
      ["base/git", "installed", 0],
      ["base/jq", "installed", 0],
      ["base/ripgrep", "installed", 0],
      ["base/build-essential", "installed", 400 * 1024 * 1024],
      ["base/fd", "installed", 0],
      ["base/sqlite3", "installed", 0],
      ["base/wget", "installed", 0],
      ["base/zip", "installed", 0],
      ["base/xz", "installed", 0],
      ["base/rsync", "installed", 0],
    ]);
    expect(out.line).toBe("uv 0.12.9, python3 3.12.13, git 2.43.0, jq 1.7.1, rg 14.1.0, curl 8.5.0, cc 12.2.0 (400 MB)");
    // Once against the image as it arrives, once after the floor ran: the first says what there is nothing to do for.
    expect(g.cmds.filter(c => c.includes("VERSION curl:"))).toHaveLength(2);
    expect(g.ran).toHaveLength(16);
  });

  it("reads df once between installs, and sizes an install after the rescue from the reading the cleanup left", async () => {
    let free = 1800;
    const g = guest(script => {
      if (script.includes("rm -rf /root/.npm")) {
        free = 3000;
        return ok;
      }
      if (script.includes("nodejs.org/dist")) {
        free -= 250;
        return { exitCode: 0, stdout: "NODE_INSTALLED v22.23.2\n", stderr: "" };
      }
      return undefined;
    }, () => mb(free));
    const { stages, stage } = recorder();
    const out = await installBase(g.machine, stage);
    expect(stages[0]).toBe("deploying-daemon:1.8 GB free, under the 2 GB floor; cleaning up before skipping");
    expect(out.tools.map(t => [t.id, t.outcome, t.bytes])).toEqual([
      ["base/login-path", "installed", 0],
      ["base/apt-index", "installed", 0],
      ["base/curl", "installed", 0],
      ["base/uv", "installed", 0],
      ["base/python", "installed", 0],
      ["base/git", "installed", 0],
      ["base/jq", "installed", 0],
      ["base/ripgrep", "installed", 0],
      ["base/build-essential", "installed", 0],
      ["base/fd", "installed", 0],
      ["base/sqlite3", "installed", 0],
      ["base/wget", "installed", 0],
      ["base/zip", "installed", 0],
      ["base/xz", "installed", 0],
      ["base/rsync", "installed", 0],
    ]);
    // One read before the loop; the rescue's sweep reads before and after itself and the loop reads once more after
    // it; one after each of the fifteen installs; the closing sweep and line read three more.
    expect(g.cmds.filter(c => c === FREE_KB_CMD)).toHaveLength(22);
  });

  it("a step that fails is named on the stage and in the line, and what waited on it is skipped by its name", async () => {
    const g = guest(script => (script.includes("apt-get update -qq") ? { exitCode: 100, stdout: "", stderr: "E: Could not get lock /var/lib/apt/lists/lock" } : script.includes("VERSION curl:") ? { exitCode: 0, stdout: "VERSION uv: uv 0.12.9\nVERSION python3: Python 3.12.13\n", stderr: "" } : undefined));
    const { stages, stage } = recorder();
    const out = await installBase(g.machine, stage);
    // The index leads the floor now, so an index that fails takes curl with it, and the roads that fetch a release
    // wait on curl: the cascade names each row by what it waited on.
    expect(out.tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["base/login-path", "installed", undefined],
      ["base/apt-index", "failed", "E: Could not get lock /var/lib/apt/lists/lock"],
      ["base/curl", "skipped", "apt index did not install"],
      ["base/uv", "skipped", "curl did not install"],
      ["base/python", "skipped", "uv did not install"],
      ["base/git", "skipped", "apt index did not install"],
      ["base/jq", "skipped", "apt index did not install"],
      ["base/ripgrep", "skipped", "apt index did not install"],
      ["base/build-essential", "skipped", "apt index did not install"],
      ["base/fd", "skipped", "apt index did not install"],
      ["base/sqlite3", "skipped", "apt index did not install"],
      ["base/wget", "skipped", "apt index did not install"],
      ["base/zip", "skipped", "apt index did not install"],
      ["base/xz", "skipped", "apt index did not install"],
      ["base/rsync", "skipped", "apt index did not install"],
    ]);
    expect(out.line).toBe("uv 0.12.9, python3 3.12.13; curl skipped (apt index did not install); uv skipped (curl did not install); Python 3.12 skipped (uv did not install); git skipped (apt index did not install); jq skipped (apt index did not install); ripgrep skipped (apt index did not install); C toolchain with cmake and ninja skipped (apt index did not install); fd skipped (apt index did not install); sqlite3 skipped (apt index did not install); wget skipped (apt index did not install); zip and unzip skipped (apt index did not install); xz skipped (apt index did not install); rsync skipped (apt index did not install)");
    expect(stages).toContain("deploying-daemon:1 installed, 1 failed: apt index (E: Could not get lock /var/lib/apt/lists/lock), 13 skipped: curl, git, jq, ripgrep, C toolchain with cmake and ninja, fd, sqlite3, wget, zip and unzip, xz, rsync (apt index did not install); uv (curl did not install); Python 3.12 (uv did not install); caches swept; 2.9 GB free");
  });

  it("a floor step that fails is recorded by the last line its installer wrote, not a generic one", async () => {
    const g = guest(script => (script.includes("apt-get install -y -qq fd-find") ? { exitCode: 100, stdout: "Reading package lists...\n", stderr: "E: Unable to locate package fd-find\n" } : script.includes("VERSION curl:") ? { exitCode: 0, stdout: "VERSION node: v22.23.2\n", stderr: "" } : undefined));
    const out = await installBase(g.machine, () => {});
    expect(out.tools.find(t => t.id === "base/fd")).toMatchObject({ outcome: "failed", note: "E: Unable to locate package fd-find" });
    expect(out.line).toBe("node 22.23.2; fd failed (E: Unable to locate package fd-find)");
  });

  it("a floor row the provider's image already satisfies reads as on the machine and installs nothing; what waited on it still runs", async () => {
    // A row the image already satisfies read failed while the tool was there, since its install is not idempotent.
    // The row taken here promises a second command too, so both have to answer before the row counts as carried;
    // curl and git ride along to prove an apt row counts the same.
    const onImage = ["VERSION zip: Zip 3.0 (July 5th 2008)", "VERSION unzip: UnZip 6.00 of 20 April 2009", "VERSION curl: curl 8.5.0", "VERSION git: git version 2.43.0", ""].join("\n");
    const g = guest(script => (script.includes("VERSION curl:") ? { exitCode: 0, stdout: VERSIONS_OUT, stderr: "" } : undefined), () => mb(3000), onImage);
    const { stages, stage } = recorder();
    const out = await installBase(g.machine, stage);
    const row = (id: string) => out.tools.find(t => t.id === id);
    expect(row("base/zip")).toEqual({ id: "base/zip", label: "zip and unzip", outcome: "installed", note: ALREADY_ON_MACHINE });
    expect(row("base/curl")).toMatchObject({ outcome: "installed", note: ALREADY_ON_MACHINE });
    expect(row("base/git")).toMatchObject({ outcome: "installed", note: ALREADY_ON_MACHINE });
    // Nothing was typed for them, and the rows that waited on curl and on the index ran all the same.
    expect(g.ran.some(script => script.includes("apt-get install -y -qq zip unzip"))).toBe(false);
    expect(g.ran.some(script => script.includes("apt-get install -y -qq git"))).toBe(false);
    expect(row("base/uv")).toMatchObject({ outcome: "installed" });
    expect(g.ran.some(script => script.includes("astral-sh/uv/releases"))).toBe(true);
    // The floor keeps its catalog order whether a row ran or the image had it, and the line says which were there.
    expect(out.tools.map(t => t.id)).toEqual(["base/login-path", "base/apt-index", ...BASE_FLOOR.map(e => `base/${e.id}`)]);
    // The words are true whichever road put the tool there: the provider's image, or an earlier run of this stage.
    expect(out.line).toContain("already on the machine: curl, git, zip and unzip");
    expect(stages.some(s => s.includes("zip and unzip ("))).toBe(false);
  });

  it("a floor row that pins a major runs when the image carries another, and the apt index is left out when no apt row needs it", async () => {
    const older = ["VERSION python3: Python 3.11.2", "VERSION uv: uv 0.12.9", ""].join("\n");
    // Python 3.12 is what the floor promises: an image on another major is not a floor that is there.
    expect([...carriedByImage(parseVersions(older))]).toEqual(["uv"]);
    expect([...carriedByImage(parseVersions("VERSION python3: Python 3.12.1\nVERSION uv: uv 0.12.9\n"))]).toEqual(["uv", "python"]);
    // zip promises unzip too, so a zip with no unzip beside it is not the floor's row.
    expect([...carriedByImage(parseVersions("VERSION zip: Zip 3.0\n"))]).toEqual([]);
    // The index is read for the rows that wait on it; an image that carries every one of them is read for nothing.
    const waitingOnApt = BASE_FLOOR.filter(e => installAfter(e) === APT_INDEX).map(e => e.id);
    expect(baseInstalls(new Set(waitingOnApt)).some(t => t.id === "base/apt-index")).toBe(false);
    expect(baseInstalls(new Set(waitingOnApt.slice(1))).some(t => t.id === "base/apt-index")).toBe(true);
    // A row whose own dependency the image carries waits on nothing rather than on a step the plan no longer holds.
    expect(baseInstalls(new Set(["curl"])).find(t => t.id === "base/uv")).not.toHaveProperty("after");
    expect(baseInstalls(new Set(["curl"])).find(t => t.id === "base/git")).toMatchObject({ after: "base/apt-index" });
  });

  it("an install that exits 0 without its command on PATH is a failure, not a version", async () => {
    const g = guest(script => (script.includes("for b in") && script.includes("command -v") ? { exitCode: 0, stdout: "missing fd\n", stderr: "" } : script.includes("VERSION curl:") ? { exitCode: 0, stdout: "VERSION node: v22.23.2\n", stderr: "" } : undefined));
    const out = await installBase(g.machine, () => {});
    expect(out.tools.find(t => t.id === "base/fd")).toMatchObject({ outcome: "failed", note: "fd is not on PATH after the install" });
    expect(out.line).toBe("node 22.23.2; fd failed (fd is not on PATH after the install)");
  });
});
