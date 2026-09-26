// SPDX-License-Identifier: AGPL-3.0-only
// The rows a recipe carries that the catalog does not: where they land in the
// plan, what they run with, and what the tools stage records for them.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { APT_INDEX, BREW_ENV, BREW_PREFIX, BREW_REAL, FROM_A_READABLE_DIR, LINUXBREW_SHIM, brewHasCheck } from "@wsp/catalog";
import type { RecipeCustomRow } from "@wsp/protocol";
import { CUSTOM_PREFIX, TOOLS_PATH, customInstallsFor, customPrelude, recipeDigest, recipeHash, toolInstallsFor, type RecipeEntry } from "../src/golden-import.js";
import { diffRecipes } from "../src/golden-diff.js";
import { installTools } from "../src/golden-tools.js";
import type { ExecResult, Machine } from "../src/machine.js";

const just: RecipeCustomRow = { kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "added by the agent" };
const ruff: RecipeCustomRow = { kind: "custom", id: "ruff", name: "ruff", install: ["uv tool install ruff"], check: "ruff --version", why: "used in wsp" };
/** A row an agent added under a label of its own words, carrying the comma the tally joins its names with. */
const pair: RecipeCustomRow = { kind: "custom", id: "swift-format, swiftlint", name: "swift-format, swiftlint", install: ["brew install swift-format swiftlint"], check: "command -v swift-format", why: "added by the agent" };

const row = (over: Partial<RecipeEntry> & { id: string }): RecipeEntry => ({ rung: "tools", label: over.id, paths: [], bytes: 0, default: "bring", bring: true, linux: "yes", ...over });

/** A command run through this machine's own bash, as a guest's shell would run it. */
function shellOut(cmd: string): ExecResult {
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** A builder that answers every script from a table, keyed by a fragment of it; anything else exits 0. The batched
 * check run answers the way a guest's shell would: exit 0, with the marker line the stage reads for the row that is
 * not there, naming that row by its place in the run as the emitted printf does. `checksBroken` is the other case,
 * the run itself failing. */
function builder(over: { fail?: string; checkFails?: string; checksBroken?: boolean } = {}): Machine & { scripts: string[]; inline: string[] } {
  const scripts: string[] = [];
  const inline: string[] = [];
  const answer = (text: string, seen: string[]): ExecResult => {
    seen.push(text);
    if (over.fail !== undefined && text.includes(over.fail)) return { exitCode: 1, stdout: "", stderr: `Error: ${over.fail} is not available` };
    if (text.includes("wsp-check")) {
      if (over.checksBroken === true) return { exitCode: 1, stdout: "", stderr: "bash: no such shell" };
      const failing = over.checkFails;
      const checks = text.split("\n").filter(l => l.startsWith("if ! out="));
      const at = failing === undefined ? -1 : checks.findIndex(l => l.includes(failing));
      return { exitCode: 0, stdout: at === -1 ? "" : `wsp-check ${at} command not found\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return {
    id: "m1",
    kind: "sandbox",
    exec: async cmd => answer(cmd, inline),
    run: async script => answer(script, scripts),
    snapshot: async () => "snap",
    pause: async () => {},
    resume: async () => {},
    kill: async () => {},
    state: async () => "running",
    downloadUrl: async () => "https://x",
    uploadUrl: async () => "https://x",
    scripts,
    inline,
  };
}

describe("the plan's rows outside the catalog", () => {
  it("run after every catalog road, in the order the recipe carries them", () => {
    const plan = toolInstallsFor([row({ id: "tools/npm/turbo" }), row({ id: "tools/brew/fd" })], new Map(), [just, ruff]);
    expect(plan.installs.slice(-2).map(t => t.id)).toEqual([`${CUSTOM_PREFIX}just`, `${CUSTOM_PREFIX}ruff`]);
    expect(plan.installs.some(t => t.id === "tools/npm/turbo")).toBe(true);
    expect(plan.installs.findIndex(t => t.id === `${CUSTOM_PREFIX}just`)).toBeGreaterThan(plan.installs.findIndex(t => t.id === "tools/npm/turbo"));
  });

  it("run their lines as given, under the env the catalog roads run with", () => {
    const [install] = customInstallsFor([just]);
    const CUSTOM_PRELUDE = customPrelude(TOOLS_PATH);
    expect(install!.cmd).toBe(`${CUSTOM_PRELUDE}\nbrew install just`);
    expect(CUSTOM_PRELUDE).toContain("export PATH=");
    expect(CUSTOM_PRELUDE).toContain("DEBIAN_FRONTEND=noninteractive");
    // Homebrew's build environment: the shim on that PATH is what drops the row's brew line to the linuxbrew user,
    // and su carries these through to it.
    expect(CUSTOM_PRELUDE).toContain(`export ${BREW_ENV}`);
    expect(CUSTOM_PRELUDE).not.toContain("brew()");
    expect(install!.label).toBe("just");
    expect(install!.check).toBe("command -v just");
  });

  it("keep a hand-written brew line's own quoting: the arguments reach Homebrew as they were typed, as linuxbrew", () => {
    // The shim runs for real here, installed as the file the golden writes and found the way a shell finds it, on
    // PATH under the name brew. su is a stand-in (nobody here may run one, and macOS's su takes other flags),
    // reading the same form the shim writes: -s SHELL USER -c SCRIPT -- ARGS. What it proves is the shim's own
    // doing: the user it drops to, and that each argument arrives whole through two shells.
    const dir = mkdtempSync(join(tmpdir(), "wsp-shim-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "su"), '#!/bin/sh\nshell=/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -s) shell="$2"; shift 2 ;; -c) script="$2"; shift 2 ;; --) shift; break ;; *) echo "[as $1]"; shift ;; esac; done\nexec "$shell" -c "$script" "$@"\n', { mode: 0o755 });
    writeFileSync(join(dir, "brew-stub"), '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n', { mode: 0o755 });
    writeFileSync(join(dir, "brew"), `${LINUXBREW_SHIM.replaceAll(BREW_REAL, join(dir, "brew-stub"))}\n`, { mode: 0o755 });
    const out = execFileSync("bash", ["-c", 'brew install "some formula" --flag'], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}` } });
    expect(out.trim().split("\n")).toEqual(["[as linuxbrew]", "[install]", "[some formula]", "[--flag]"]);
  });

  it("bring the manager the row's line calls: a brew row brings Homebrew and its toolchain, and waits on them", () => {
    const brewRow: RecipeCustomRow = { ...just, id: "brew/just", manager: "brew" };
    const plan = toolInstallsFor([], new Map(), [brewRow]);
    expect(plan.installs.map(t => t.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", `${CUSTOM_PREFIX}brew/just`]);
    // The row waits on the last toolchain step, as a formula on the brew road does.
    expect(plan.installs.at(-1)!.after).toBe("tools/brew-toolchain/gcc");
  });

  it("wait on the apt index the machine reads once: an apt row installs after apt-get update and brings no manager, since every machine has apt", () => {
    const aptRow: RecipeCustomRow = { kind: "custom", id: "apt/direnv", name: "direnv", install: ["export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq direnv"], check: "dpkg -s 'direnv'", manager: "apt", why: "installed on this computer by apt" };
    const plan = toolInstallsFor([], new Map(), [aptRow]);
    expect(plan.installs.map(t => t.id)).toEqual([`tools/${APT_INDEX}`, `${CUSTOM_PREFIX}apt/direnv`]);
    expect(plan.installs.at(-1)!.after).toBe(`tools/${APT_INDEX}`);
    expect(plan.installs[0]!.cmd).toContain("apt-get update");
  });

  it("bring a manager the base does not carry as its own step, and wait on that: a pipx row gets pipx", () => {
    const pipxRow: RecipeCustomRow = { ...ruff, id: "pipx/ruff", manager: "pipx" };
    const plan = toolInstallsFor([], new Map(), [pipxRow]);
    expect(plan.installs.map(t => t.id)).toContain("tools/manager/pipx");
    expect(plan.installs.at(-1)).toMatchObject({ id: `${CUSTOM_PREFIX}pipx/ruff`, after: "tools/manager/pipx" });
  });

  it("wait on nothing when the base already carries the manager, or when the row names none", () => {
    // uv and npm are on every machine from the base, so there is no step to wait on.
    const uvRow: RecipeCustomRow = { ...ruff, id: "uv/ruff", manager: "uv" };
    expect(toolInstallsFor([], new Map(), [uvRow]).installs).toEqual([expect.objectContaining({ id: `${CUSTOM_PREFIX}uv/ruff` })]);
    expect(toolInstallsFor([], new Map(), [uvRow]).installs[0]).not.toHaveProperty("after");
    expect(toolInstallsFor([], new Map(), [just]).installs[0]).not.toHaveProperty("after");
  });

  it("has no plan at all when the recipe carries none", () => {
    expect(toolInstallsFor([], new Map()).installs.filter(t => t.id.startsWith(CUSTOM_PREFIX))).toEqual([]);
  });
});

describe("how a row outside the catalog is read back off a machine", () => {
  /** The form the scan wrote beside a formula row on the day it ran: Homebrew's own list, without the line that
   * leaves a directory linuxbrew cannot read, so it refuses from the working directory the job runs in. A recipe
   * carries this string unchanged for as long as the row lives, which is why the row cannot be read by it. */
  const frozenCheck = (formula: string): string =>
    `su -s /bin/bash linuxbrew -c 'HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 NONINTERACTIVE=1 /home/linuxbrew/.linuxbrew/bin/brew list --versions '\\''${formula}'\\'''`;
  const formulaRow = (formula: string): RecipeCustomRow => ({ kind: "custom", id: `brew/${formula}`, name: formula, install: [`brew install ${formula}`], check: frozenCheck(formula), manager: "brew", why: "installed on this computer by brew" });

  it("is its road's two reads for a row whose manager the catalog knows: the prefix's link, and Homebrew's own list as the check", () => {
    const [step] = customInstallsFor([formulaRow("bat")]);
    expect(step!.present).toBe(`test -e ${BREW_PREFIX}/opt/bat`);
    expect(step!.check).toBe(brewHasCheck("bat"));
    // The presence read runs no brew at all, which is what lets a workspace answer it.
    expect(step!.present).not.toContain("list --versions");
    expect(step!.present).not.toContain("su -s");
    // The check does run brew, through the one line that leaves a directory linuxbrew cannot read.
    expect(step!.check).toContain(FROM_A_READABLE_DIR);
  });

  it("is never the check the recipe froze into the row, where the catalog knows the row's manager", () => {
    const frozen = formulaRow("bat");
    const [step] = customInstallsFor([frozen]);
    expect([step!.check, step!.present, step!.cmd, step!.shown]).not.toContain(frozen.check);
    // What the frozen string is missing, and the road's own check is not.
    expect(frozen.check).not.toContain(FROM_A_READABLE_DIR);
    expect(step!.check).toContain(FROM_A_READABLE_DIR);
  });

  it("is the row's own check where the catalog reads no road for its manager, since nothing else can read the row", () => {
    const byHand = customInstallsFor([just])[0]!;
    expect(byHand.check).toBe("command -v just");
    expect(byHand).not.toHaveProperty("present");
    const mise: RecipeCustomRow = { ...ruff, id: "mise/ruff", manager: "mise", check: "mise which ruff" };
    expect(customInstallsFor([mise])[0]!.check).toBe("mise which ruff");
    // apt is a road the catalog has and reads no row of its own, since every machine carries apt already.
    const apt: RecipeCustomRow = { kind: "custom", id: "apt/direnv", name: "direnv", install: ["apt-get install -y -qq direnv"], check: "dpkg -s 'direnv'", manager: "apt", why: "installed on this computer by apt" };
    expect(customInstallsFor([apt])[0]!.check).toBe("dpkg -s 'direnv'");
  });

  it("reads a formula the same way whether the recipe carried the row or the tools rung did", () => {
    const fromRung = toolInstallsFor([row({ id: "tools/brew/bat" })], new Map()).installs.find(t => t.id === "tools/brew/bat")!;
    const fromRecipe = toolInstallsFor([], new Map(), [formulaRow("bat")]).installs.at(-1)!;
    expect(fromRecipe.id).toBe(`${CUSTOM_PREFIX}brew/bat`);
    expect([fromRecipe.present, fromRecipe.check, fromRecipe.bins]).toEqual([fromRung.present, fromRung.check, fromRung.bins]);
  });

  it("reads every formula row a recipe carries by its own link, whatever each row froze", () => {
    const formulae = ["bat", "beads", "btop", "dust", "eza"];
    const plan = toolInstallsFor([], new Map(), formulae.map(formulaRow));
    const rows = plan.installs.filter(t => t.id.startsWith(`${CUSTOM_PREFIX}brew/`));
    expect(rows.map(t => [t.present, t.check])).toEqual(formulae.map(f => [`test -e ${BREW_PREFIX}/opt/${f}`, brewHasCheck(f)]));
    for (const t of plan.installs) if (t.check?.includes("brew list") === true) expect(t.check, t.id).toContain(FROM_A_READABLE_DIR);
  });
});

describe("a recipe's rows outside the catalog in its digest", () => {
  const entries = [row({ id: "tools/brew/fd" })];

  it("pin the golden: adding one, changing its line or dropping it is another golden", () => {
    const none = recipeHash(recipeDigest(entries, [], [], new Map()));
    const one = recipeHash(recipeDigest(entries, [], [just], new Map()));
    const other = recipeHash(recipeDigest(entries, [], [{ ...just, install: ["apt-get install -y just"] }], new Map()));
    expect(new Set([none, one, other]).size).toBe(3);
    expect(recipeHash(recipeDigest(entries, [], [just, ruff], new Map()))).toBe(recipeHash(recipeDigest(entries, [], [ruff, just], new Map())));
  });

  it("a check that changed alone is not a change to the machine", () => {
    expect(recipeHash(recipeDigest(entries, [], [just], new Map()))).toBe(recipeHash(recipeDigest(entries, [], [{ ...just, check: "just --version" }], new Map())));
  });

  it("read as an added, changed or removed tool when a later run is diffed against the golden's own digest", () => {
    const before = recipeDigest(entries, [], [just], new Map());
    const after = recipeDigest(entries, [], [{ ...just, install: ["apt-get install -y just"] }, ruff], new Map());
    expect(diffRecipes(before, after).tools).toEqual([
      { id: "tools/custom/just", label: "just", change: "changed", from: "brew install just", to: "apt-get install -y just" },
      { id: "tools/custom/ruff", label: "ruff", change: "added", to: "uv tool install ruff" },
    ]);
    expect(diffRecipes(after, before).tools.map(t => t.change)).toEqual(["changed", "removed"]);
  });
});

describe("the tools stage on rows outside the catalog", () => {
  it("runs each one alone, names the exact command on the step's frames, and records the outcome by name", async () => {
    const machine = builder();
    const frames: string[] = [];
    const out = await installTools(machine, customInstallsFor([just, ruff]), (_stage, detail, step) => frames.push(step === undefined ? (detail ?? "") : `${detail} [${step.label}: ${step.command}]`));
    expect(out.tools.map(t => ({ label: t.label, outcome: t.outcome }))).toEqual([
      { label: "just", outcome: "installed" },
      { label: "ruff", outcome: "installed" },
    ]);
    expect(frames).toContain("just (1/2) [just: brew install just]");
    expect(frames).toContain("ruff (2/2) [ruff: uv tool install ruff]");
    expect(machine.scripts.filter(s => s.includes("brew install just"))).toHaveLength(1);
    // A row may type any manager's command, so its script opens under set -e with every road's network clock, and takes the script road's limit.
    const script = machine.scripts.find(s => s.includes("brew install just"))!;
    expect(script).toMatch(/set -euo pipefail\nexport npm_config_fetch_timeout=60000 .*\nexport PIP_TIMEOUT=60 .*\nexport UV_HTTP_TIMEOUT=60 .*\nexport CARGO_HTTP_TIMEOUT=60 .*\ncurl\(\) \{ command curl --connect-timeout 15 .*\nexport PATH=/);
    expect(script).toContain("while [ $t -lt 600 ]");
  });

  it("checks each one after its install, and a row whose install exited 0 without leaving the tool is a failure", async () => {
    const machine = builder({ checkFails: "ruff --version" });
    const out = await installTools(machine, customInstallsFor([just, ruff]), () => {});
    expect(out.tools.map(t => t.outcome)).toEqual(["installed", "failed"]);
    expect(out.tools[1]!.note).toBe("the check did not pass (ruff --version): command not found");
    // One run answers for every row, and each check is named in it.
    const runs = machine.inline.filter(c => c.includes("wsp-check"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("command -v just");
    expect(runs[0]).toContain("ruff --version");
  });

  it("reads the checks with one real shell run: the row whose check exits non-zero is the one that fails", async () => {
    // The batched script runs under this machine's bash, so its own shape is proven rather than read: the marker
    // line, the failing check's last line, and the run exiting 0 even when a check did not.
    const machine = builder();
    machine.exec = async cmd => (cmd.includes("wsp-check") ? shellOut(cmd) : { exitCode: 0, stdout: "", stderr: "" });
    const there = { ...just, id: "there", name: "there", check: "true" };
    const gone = { ...ruff, id: "gone", name: "gone", check: "definitely-not-a-command-xyz --version" };
    const out = await installTools(machine, customInstallsFor([there, gone]), () => {});
    expect(out.tools.map(t => ({ label: t.label, outcome: t.outcome }))).toEqual([
      { label: "there", outcome: "installed" },
      { label: "gone", outcome: "failed" },
    ]);
    expect(out.tools[1]!.note).toContain("definitely-not-a-command-xyz: command not found");
  });

  it("reads a failed check back onto the row whose id carries a space, which the marker line's own split broke", async () => {
    // The run names each row by its place in the run, not by an id that can carry the space the marker is parsed on.
    const machine = builder();
    machine.exec = async cmd => (cmd.includes("wsp-check") ? shellOut(cmd) : { exitCode: 0, stdout: "", stderr: "" });
    const gone = { ...pair, check: "definitely-not-a-command-xyz --version" };
    const there = { ...ruff, check: "true" };
    const out = await installTools(machine, customInstallsFor([gone, there]), () => {});
    expect(out.tools.map(t => ({ label: t.label, outcome: t.outcome }))).toEqual([
      { label: "swift-format, swiftlint", outcome: "failed" },
      { label: "ruff", outcome: "installed" },
    ]);
    expect(out.tools[0]!.note).toContain("definitely-not-a-command-xyz: command not found");
  });

  it("says so in the stage detail when the checks could not be run at all, and counts every checked row as failed", async () => {
    const machine = builder({ checksBroken: true });
    const lines: string[] = [];
    const out = await installTools(machine, customInstallsFor([just, ruff]), (_stage, detail) => lines.push(detail ?? ""));
    expect(out.tools.map(t => t.outcome)).toEqual(["failed", "failed"]);
    expect(out.tools[0]!.note).toContain("the check could not be run (command -v just)");
    expect(lines.find(l => l.startsWith("the checks could not be run"))).toContain("just, ruff count as failed");
  });

  it("quotes a label that carries the tally's own separator, so the summary names one row where a bare label read as two", async () => {
    const machine = builder({ fail: "brew install swift-format" });
    const lines: string[] = [];
    const waits = customInstallsFor([pair, ruff], c => (c.id === "ruff" ? `${CUSTOM_PREFIX}${pair.id}` : undefined));
    await installTools(machine, waits, (_stage, detail) => lines.push(detail ?? ""));
    const tally = lines.at(-1)!;
    expect(tally).toContain(`1 failed: "swift-format, swiftlint" (Error: brew install swift-format is not available)`);
    expect(tally).toContain("1 skipped: ruff (swift-format, swiftlint did not install)");
    // With the quoted label read as one word and the bracketed reasons off, every comma left separates two entries.
    expect(tally.replace(/"[^"]*"/g, "row").replace(/ \([^()]*\)/g, "").split("; ")[0]!.split(", ")).toEqual(["0 installed", "1 failed: row", "1 skipped: ruff"]);
  });

  it("quotes the same label in the line that says the checks could not be run, where the names stand on their own", async () => {
    const machine = builder({ checksBroken: true });
    const lines: string[] = [];
    await installTools(machine, customInstallsFor([pair, ruff]), (_stage, detail) => lines.push(detail ?? ""));
    expect(lines.find(l => l.startsWith("the checks could not be run"))).toContain(`"swift-format, swiftlint", ruff count as failed`);
  });

  it("lets a failed row fail alone: it is named with its reason and the rows after it still install", async () => {
    const machine = builder({ fail: "brew install just" });
    const out = await installTools(machine, customInstallsFor([just, ruff]), () => {});
    expect(out.tools[0]).toMatchObject({ label: "just", outcome: "failed", note: "Error: brew install just is not available" });
    expect(out.tools[1]).toMatchObject({ label: "ruff", outcome: "installed" });
  });
});
