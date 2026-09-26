// SPDX-License-Identifier: AGPL-3.0-only
// The catalog's own invariants: ids are unique, every road is a known one,
// every browser or device sign-in has a status that proves it, the agents are
// the six whose project state has a measured resolver, every default names
// its evidence, and the seeded rows are what the snapshot says they are.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import * as catalog from "../src/index.js";
import { pinMismatchLine, SHARED_TOOL_ROOTS, TOOLS_PATH, WORKSPACE_OVERLAID } from "@wsp/protocol";
import { agentName, APT_INDEX, BREW_PREFIX, GUEST_HOME, APT_UPDATE, BASE_FLOOR, baseEntryFor, baseNote, BREW_ENV, CATALOG, CATALOG_AGENTS, catalogEntry, catalogToolFor, catalogToolForDependency, CLAUDE_CONFIG_DIR, CURL_NET, DEFAULT_AGENT, GCLOUD, guestEnv, hasLogin, HISTORY_FORMATS, HOMEBREW_STEP, installAfter, installLine, installShown, keysIdOf, keysRowOf, KUBECTL, LINUX_CASKS, LOGIN_ROWS, loginIdOf, loginRow, mintsToken, NO_SIGN_IN, NET_READ_S, NET_RETRIES, pinCheckLine, PLAYWRIGHT, readsRowRoad, RELEASE_PINS, runsThreads, THREAD_AGENTS, LOCAL_BIN, installHomes, TOOL_PREFIX, ROAD_MODULES, ROAD_STEPS, roadModule, ROADS, SIGN_IN_ROWS, SIZE_METHODS, sizeBytes, smokeOf, standingPin, unpinned, versionOf, fixesVersion, catalogIdOfRow, type AgentEntry, type InstallRoad, type ToolEntry } from "../src/index.js";

describe("catalog", () => {
  it("the default agent is the first entry, and it is an agent with a context module", () => {
    expect(DEFAULT_AGENT).toBe(CATALOG_AGENTS[0]);
    expect(DEFAULT_AGENT.id).toBe("claude");
    expect(DEFAULT_AGENT.context).toBeDefined();
  });

  it("names a session history for the agents with a reader, in a known format under a home path", () => {
    expect(CATALOG_AGENTS.filter(a => a.history !== undefined).map(a => a.id)).toEqual(["claude", "codex", "hermes"]);
    for (const a of CATALOG_AGENTS) {
      if (a.history === undefined) continue;
      expect(HISTORY_FORMATS, a.id).toContain(a.history.format);
      expect(a.history.root, a.id).toMatch(/^~\/\./);
    }
  });

  it("finds the tool a package name stands for by id, command, road name, cover or brought command; the floor is the subset on it", () => {
    expect(catalogToolFor("rg")?.id).toBe("ripgrep");
    expect(catalogToolFor("cli/cli")).toBeUndefined();
    expect(catalogToolFor("awscli")?.id).toBe("aws");
    expect(catalogToolFor("npm")?.id).toBe("node");
    expect(catalogToolFor("openjdk@21")?.id).toBe("java");
    expect(catalogToolFor("cargo")?.id).toBe("rust");
    // Homebrew's own name for the same toolchain, and the installer's: both are the rust row, so neither plans a second install.
    expect(catalogToolFor("rustup")?.id).toBe("rust");
    expect(catalogToolFor("rustup-init")?.id).toBe("rust");
    expect(baseEntryFor("cargo")).toBeUndefined();
    expect(baseEntryFor("npm")).toBeUndefined();
    expect(catalogToolFor("claude")).toBeUndefined();
  });

  it("gives every entry its own id", () => {
    const ids = CATALOG.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(catalogEntry("gh")?.name).toBe("GitHub CLI");
    expect(catalogEntry("nothing")).toBeUndefined();
  });

  it("names an entry as the catalog does and an id it does not know as itself", () => {
    expect(agentName("claude")).toBe("Claude Code");
    expect(agentName("gemini")).toBe("Gemini CLI");
    expect(agentName("gh")).toBe("GitHub CLI");
    expect(agentName("zed")).toBe("zed");
  });

  it("a golden's env for an agent points it at its guest state home only when the entry names the variable", () => {
    expect(guestEnv(catalogEntry("claude") as AgentEntry)).toEqual({ CLAUDE_CONFIG_DIR });
    for (const a of CATALOG_AGENTS.slice(1)) expect(guestEnv(a), a.id).toEqual({});
  });

  it("sends every entry down a known road with its argument", () => {
    for (const e of CATALOG) {
      const road = e.installRoad;
      expect(ROADS, e.id).toContain(road.road);
      switch (road.road) {
        case "brew":
          expect(road.formula, e.id).toMatch(/^[\w@.+-]+$/);
          break;
        case "npm":
        case "pnpm":
        case "bun":
        case "uv":
        case "pipx":
        case "cargo":
          expect(road.package, e.id).toMatch(/^(@[\w.-]+\/)?[\w.-]+$/);
          break;
        case "go":
          expect(road.module, e.id).toMatch(/^[\w.-]+\.[a-z]+\//);
          break;
        case "release":
          expect(road.repo, e.id).toMatch(/^[\w.-]+\/[\w.-]+$/);
          break;
        case "vendor":
          expect(LINUX_CASKS, e.id).toContain(road.cask);
          break;
        case "apt":
          expect(road.packages.length, e.id).toBeGreaterThan(0);
          break;
        case "script":
          expect(road.script, e.id).not.toBe("");
          break;
        default: {
          const _exhaustive: never = road;
          return _exhaustive;
        }
      }
    }
  });

  it("names the artifact and the sum before anything runs: every release row a pinned tag and an asset per arch, every cask a version and two sums, and no row asking a vendor what its current version is", () => {
    const releases = CATALOG.filter(e => e.installRoad.road === "release");
    expect(releases.map(e => e.id)).toEqual(["crush", "goose", "gh", "cloudflared", "fly", "supabase", "doppler", "yq", "golangci-lint", "mise", "git-delta", "bazel"]);
    for (const e of releases) {
      const road = e.installRoad as Extract<InstallRoad, { road: "release" }>;
      const pin = RELEASE_PINS[road.repo!];
      // Every release row goes through the one helper that reads the table, so no row carries a tag of its own.
      expect(pin, e.id).toBeDefined();
      expect(road.version, e.id).toBe(pin!.tag);
      expect(road.assets, e.id).toBe(pin!.assets);
      for (const arch of ["x86_64", "aarch64"] as const) {
        expect(road.assets?.[arch]?.name, `${e.id} ${arch}`).toMatch(/^[\w.+-]+$/);
        expect(road.assets?.[arch]?.sha256, `${e.id} ${arch}`).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(Object.keys(RELEASE_PINS).sort()).toEqual(releases.map(e => (e.installRoad as Extract<InstallRoad, { road: "release" }>).repo!).sort());
    for (const cask of LINUX_CASKS) {
      expect(cask.version, cask.bin).toMatch(/^v?\d/);
      expect(cask.sha256.x86_64, cask.bin).toMatch(/^[0-9a-f]{64}$/);
      expect(cask.sha256.aarch64, cask.bin).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const e of CATALOG.filter(e => e.installRoad.road === "vendor")) expect((e.installRoad as Extract<InstallRoad, { road: "vendor" }>).version, e.id).toBe((e.installRoad as Extract<InstallRoad, { road: "vendor" }>).cask.version);
    // Nothing any row runs asks a source what it is serving today.
    for (const e of CATALOG) {
      const line = installLine(e);
      for (const moving of ["releases/latest", "stable.txt", "components-2.json", "@latest"]) expect(line, `${e.id} reads ${moving}`).not.toContain(moving);
    }
  });

  it("one rule says which pin stands and one line checks it: the sum, the tag and both sums in the failure, on the release road and the vendor's", () => {
    const pin = { tag: "v2.86.0", sha256: "d".repeat(64) };
    // A pin stands while the road names its tag or none; a version past it, or no pin, leaves nothing to check.
    expect(standingPin({ road: "release", repo: "cli/cli", pin })).toEqual(pin);
    expect(standingPin({ road: "release", repo: "cli/cli", version: "v2.86.0", pin })).toEqual(pin);
    expect(standingPin({ road: "release", repo: "cli/cli", version: "v2.87.0", pin })).toBeUndefined();
    expect(standingPin({ road: "release", repo: "cli/cli" })).toBeUndefined();
    expect(standingPin({ road: "vendor", cask: KUBECTL, pin })).toEqual(pin);
    expect(standingPin({ road: "npm", package: "bun", version: "1.4.0" })).toBeUndefined();
    // The road without its record is what a first run installs: the pin goes, the version and assets the row names stay.
    expect(unpinned({ road: "release", repo: "cli/cli", pin })).toEqual({ road: "release", repo: "cli/cli" });
    expect(unpinned({ road: "release", repo: "cli/cli", version: "v2.86.0", pin })).toEqual({ road: "release", repo: "cli/cli", version: "v2.86.0" });
    expect(unpinned({ road: "npm", package: "bun" })).toEqual({ road: "npm", package: "bun" });
    // The failure names what came down, at which tag, then the recorded sum and the served one, each cut to 12 characters so the reason line keeps both.
    expect(pinCheckLine("$asset", "$tag", pin.sha256)).toBe(`[ "$sum" = '${"d".repeat(64)}' ] || { echo "Error: $asset at $tag does not match the checksum recorded on its first install: recorded dddddddddddd, served \${sum:0:12}" >&2; exit 1; }`);
    const release = roadModule({ road: "release", repo: "cli/cli", pin }).install({ road: "release", repo: "cli/cli", pin }, "gh") as string;
    expect(release).toContain("tag='v2.86.0'");
    expect(release).toContain(pinCheckLine("$asset", "$tag", pin.sha256));
    // A cask checks the sum it pins for the arch, whatever a recipe recorded, so its first install is checked too.
    for (const cask of LINUX_CASKS) {
      const line = cask.install;
      expect(line, cask.bin).toContain(`x86_64) a=`);
      expect(line, cask.bin).toContain(cask.sha256.x86_64);
      expect(line, cask.bin).toContain(cask.sha256.aarch64);
      expect(line, cask.bin).toContain('| sha256sum -c - >/dev/null');
      expect(line, cask.bin).not.toContain('[ "$sum" =');
      // The version line reads the cask's own, the one its two sums belong to, so a row asking for another version moves nothing.
      expect(line, cask.bin).toContain(`ver='${cask.version}'`);
      expect(ROAD_MODULES.vendor.install({ road: "vendor", cask, version: "1.0.0" }, cask.bin), cask.bin).toContain(`ver='${cask.version}'`);
      expect(ROAD_MODULES.vendor.install({ road: "vendor", cask, pin: { tag: "1.0.0", sha256: "a".repeat(64) } }, cask.bin), cask.bin).toContain(`ver='${cask.version}'`);
    }
    // The vendor's current version is asked of nobody: no cask reads a version off the network.
    for (const cask of LINUX_CASKS) expect(cask.install, cask.bin).not.toContain('ver="$(');
    // The words are the protocol's, so the reason line a person reads is the one the format test pins.
    expect(pinCheckLine("x", "y", "z")).toContain(pinMismatchLine("x", "y", "z", "${sum:0:12}"));
  });

  it("one rule says the version a road installs at, one says whether a copy gets it, and each module says how the installed version is read back in the form its own install takes", () => {
    const pin = { tag: "4.1.0" };
    // The row's version first, else the recorded pin while it stands, else the source's current one.
    expect(versionOf({ road: "npm", package: "wrangler", version: "4.2.0", pin })).toBe("4.2.0");
    expect(versionOf({ road: "npm", package: "wrangler", pin })).toBe("4.1.0");
    expect(versionOf({ road: "npm", package: "wrangler", version: "4.1.0", pin })).toBe("4.1.0");
    expect(versionOf({ road: "npm", package: "wrangler" })).toBeUndefined();
    expect(versionOf({ road: "release", repo: "cli/cli", pin: { tag: "v2.86.0", sha256: "d".repeat(64) } })).toBe("v2.86.0");
    // A package road installs at the pin the way it installs at a row's version.
    expect(ROAD_MODULES.npm.install({ road: "npm", package: "wrangler", pin }, "wrangler")).toBe("npm install -g wrangler@4.1.0");
    expect(ROAD_MODULES.pnpm.install({ road: "pnpm", package: "wrangler", pin }, "wrangler")).toBe("pnpm add -g wrangler@4.1.0");
    expect(ROAD_MODULES.uv.install({ road: "uv", package: "ruff", pin: { tag: "0.4.4" } }, "ruff")).toBe("uv tool install ruff==0.4.4");
    expect(ROAD_MODULES.cargo.install({ road: "cargo", package: "bat", pin: { tag: "0.24.0" } }, "bat")).toBe("cargo install bat --version 0.24.0 --locked");
    expect(ROAD_MODULES.go.install({ road: "go", module: "golang.org/x/tools/gopls", pin: { tag: "v0.16.2" } }, "gopls")).toBe("go install golang.org/x/tools/gopls@v0.16.2");
    // A pin the row's version moved past does not stand: the row installs at its version, a first install again.
    expect(ROAD_MODULES.npm.install({ road: "npm", package: "wrangler", version: "4.2.0", pin }, "wrangler")).toBe("npm install -g wrangler@4.2.0");
    // Which roads fix a version on a copy: the ones that install at one, and any road carrying a version of its own,
    // which after the pins table is every release and vendor row the catalog carries.
    expect(fixesVersion({ road: "npm", package: "wrangler" })).toBe(true);
    expect(fixesVersion({ road: "release", repo: "cli/cli" })).toBe(false);
    expect(fixesVersion({ road: "release", repo: "cli/cli", version: "v2.86.0" })).toBe(true);
    expect(fixesVersion({ road: "vendor", cask: KUBECTL })).toBe(false);
    expect(fixesVersion({ road: "vendor", cask: KUBECTL, version: KUBECTL.version })).toBe(true);
    expect(fixesVersion({ road: "go", module: "x" })).toBe(true);
    expect(fixesVersion({ road: "brew", formula: "go" })).toBe(false);
    expect(fixesVersion({ road: "apt", packages: ["tmux"] })).toBe(false);
    expect(fixesVersion({ road: "script", script: "x" })).toBe(false);
    expect(fixesVersion({ road: "script", script: "x", version: "6.3.3" })).toBe(true);
    for (const id of ["swift", "playwright", "hermes", "gh", "bazel", "gcloud", "kubectl"]) expect(fixesVersion(catalogEntry(id)!.installRoad), id).toBe(true);
    for (const id of ["rust", "yarn", "op"]) expect(fixesVersion(catalogEntry(id)!.installRoad), id).toBe(false);
    expect(fixesVersion(catalogEntry("claude")!.installRoad)).toBe(true);
    // A catalog row installs at the catalog's tag whatever version a recipe row asks for: the engine's plan test
    // pins the note the row gets, and the road itself never moves.
    expect(versionOf(catalogEntry("gh")!.installRoad)).toBe("v2.101.0");
    expect(versionOf(catalogEntry("kubectl")!.installRoad)).toBe(KUBECTL.version);
    expect(ROAD_MODULES.release.at).toBeUndefined();
    expect(ROAD_MODULES.vendor.at).toBeUndefined();
    // How each road reads the installed version back, each in the form its install takes: no v where the install takes none, the v where go wants it.
    expect(ROAD_MODULES.npm.installed!({ road: "npm", package: "@openai/codex" }, "codex")).toBe(`node -p 'require(process.argv[1] + "/package.json").version' "$(npm root -g)/"'@openai/codex'`);
    expect(ROAD_MODULES.pnpm.installed!({ road: "pnpm", package: "wrangler" }, "wrangler")).toContain("$(pnpm root -g)");
    expect(ROAD_MODULES.bun.installed!({ road: "bun", package: "wrangler" }, "wrangler")).toBe(`bun pm ls -g 2>/dev/null | grep -oE "(^| )wrangler@[^[:space:]]+" | head -n 1 | sed 's/.*@//'`);
    expect(ROAD_MODULES.uv.installed!({ road: "uv", package: "ruff" }, "ruff")).toBe(`uv tool list 2>/dev/null | awk -v p='ruff' '$1==p{sub(/^v/,"",$2); sub(/:$/,"",$2); print $2}'`);
    expect(ROAD_MODULES.pipx.installed!({ road: "pipx", package: "black" }, "black")).toContain("pipx list --short");
    expect(ROAD_MODULES.cargo.installed!({ road: "cargo", package: "bat" }, "bat")).toContain("cargo install --list");
    expect(ROAD_MODULES.go.installed!({ road: "go", module: "golang.org/x/tools/gopls" }, "gopls")).toBe(`go version -m /root/go/bin/'gopls' 2>/dev/null | awk '$1=="mod"{print $3}'`);
    expect(ROAD_MODULES.brew.installed!({ road: "brew", formula: "go" }, "go")).toContain("list --versions go");
    expect(ROAD_MODULES.apt.installed!({ road: "apt", packages: ["clang", "clang-format"] }, "clang")).toBe("dpkg-query -W -f='${Version}\\n' 'clang' 2>/dev/null");
    expect(ROAD_MODULES.script.installed!({ road: "script", script: "x" }, "claude")).toBe(`'claude' --version 2>/dev/null | head -n 1 | grep -oE '[0-9][^ ,()]*\\.[0-9][^ ,()]*' | head -n 1`);
    // A release's and a vendor's own install line says the tag and sum; neither reads again.
    expect(ROAD_MODULES.release.installed).toBeUndefined();
    expect(ROAD_MODULES.vendor.installed).toBeUndefined();
  });

  it("one rule names the id a recipe row is known by on every computer: the catalog id where the catalog carries the tool, whatever manager this computer has it by; nothing for an MCP row, a row outside the catalog or another rung", () => {
    expect(catalogIdOfRow({ id: "tools/npm/wrangler" })).toBe("wrangler");
    expect(catalogIdOfRow({ id: "tools/catalog/wrangler" })).toBe("wrangler");
    expect(catalogIdOfRow({ id: "tools/brew/gh" })).toBe("gh");
    expect(catalogIdOfRow({ id: "agents/codex" })).toBe("codex");
    expect(catalogIdOfRow({ id: "agents/mcp/claude/wsp" })).toBeUndefined();
    expect(catalogIdOfRow({ id: "tools/brew/zingzy/tap/diskbloom" })).toBeUndefined();
    expect(catalogIdOfRow({ id: "shell/zshrc" })).toBeUndefined();
    expect(catalogIdOfRow({ id: "logins/gh" })).toBeUndefined();
  });

  it("proves every browser or device sign-in with a status check", () => {
    for (const e of CATALOG) {
      if (e.signIn.kind === "oauth" || e.signIn.kind === "device") expect(e.signIn.status, e.id).toBeDefined();
    }
    for (const [name, row] of Object.entries(SIGN_IN_ROWS)) expect(catalogEntry(name)?.signIn, name).toBe(row);
  });

  it("files one sign-in row per login id, and a keys row beside a login whose key files travel only by copy", () => {
    // Every entry with a login or a note about having none has a row under its login id; a plain tool has none.
    for (const e of CATALOG) {
      const own = loginRow(loginIdOf(e.id));
      if (hasLogin(e.signIn) || mintsToken(e.signIn) || e.signIn.note !== undefined) expect(own?.signIn, e.id).toBe(e.signIn);
      else expect(own, e.id).toBeUndefined();
    }
    expect(loginRow("kube")?.entry.id).toBe("kubectl");
    expect(loginRow("kubectl")).toBeUndefined();
    // Hermes keeps provider keys in a file beside its device login, so it alone has a keys row: nothing to run on the
    // machine, the login's own status proves the copy, and the row says why only a copy brings the keys.
    const keyed = LOGIN_ROWS.filter(r => r.keys !== undefined);
    expect(keyed.map(r => [r.id, r.entry.id])).toEqual([["hermes-keys", "hermes"]]);
    expect(keysIdOf("hermes")).toBe("hermes-keys");
    const hermes = catalogEntry("hermes")!.signIn;
    expect(hasLogin(hermes) && hermes.keys).toEqual({ paths: ["~/.hermes/.env"], note: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them" });
    expect(loginRow("hermes-keys")?.signIn).toEqual({ kind: "none", sources: ["file"], note: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them", status: hasLogin(hermes) ? hermes.status : undefined });
    expect(keysRowOf({ paths: ["~/.x/keys"], note: "why" }, undefined)).toEqual({ kind: "none", sources: ["file"], note: "why" });
    // A keys row's note fits the detail pane beside its path line.
    for (const r of keyed) expect(r.keys!.note.length, r.id).toBeLessThanOrEqual(76);
    expect(new Set(LOGIN_ROWS.map(r => r.id)).size).toBe(LOGIN_ROWS.length);
  });

  it("ships the six agents whose project state a move can follow, each with a measured road, a smoke and a resolver", () => {
    const shipped = CATALOG_AGENTS.filter(a => a.source.road === "measured");
    expect(shipped.map(a => a.id)).toEqual(["claude", "codex", "gemini", "opencode", "pi", "hermes"]);
    for (const a of shipped) {
      expect(a.projectState.length, a.id).toBeGreaterThan(0);
      expect(hasLogin(a.signIn) || mintsToken(a.signIn), a.id).toBe(true);
      expect(sizeBytes(a.size), a.id).toBeGreaterThan(0);
    }
    for (const a of CATALOG_AGENTS) {
      expect(a.stateHome, a.id).toMatch(/^\.[\w./-]*[\w-]$/);
      if (a.guestStateHome !== undefined) expect(a.guestStateHome, a.id).toMatch(/^\/root\//);
      expect(smokeOf(a)).toBe(`${a.bin} --version`);
    }
    expect(CATALOG_AGENTS.filter(a => a.guestStateHome !== undefined).map(a => [a.id, a.guestStateHome])).toEqual([["claude", "/root/.claude-cfg"]]);
    expect(installLine(catalogEntry("codex")!)).toBe("npm install -g @openai/codex@0.153.0");
    expect(installLine(catalogEntry("pi")!)).toBe("npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4");
    expect(installLine(catalogEntry("claude")!)).toBe(catalog.CLAUDE_INSTALL);
    expect(installLine(catalogEntry("hermes")!)).toMatch(/git clone -q --depth 1 --branch v[\d.]+ https:\/\/github\.com\/NousResearch\/hermes-agent\.git/);
    // An agent's npm road is pinned in the data; an unpinned one would install whatever the registry serves that day.
    for (const a of CATALOG_AGENTS) if (a.installRoad.road === "npm") expect(a.installRoad.version, a.id).toMatch(/^\d/);
  });

  it("keeps one module per agent under src/agents, each registered once, the agents first in the catalog", () => {
    const dir = fileURLToPath(new URL("../src/agents/", import.meta.url));
    const modules = readdirSync(dir).filter(f => f.endsWith(".ts") && f !== "index.ts" && f !== "entry.ts").map(f => f.replace(/\.ts$/, "")).sort();
    expect([...CATALOG_AGENTS.map(a => a.id)].sort()).toEqual(modules);
    expect(CATALOG_AGENTS.map(a => a.id)).toEqual(["claude", "codex", "gemini", "opencode", "pi", "hermes", "crush", "qwen", "goose", "amp"]);
    expect(CATALOG.slice(0, CATALOG_AGENTS.length)).toEqual(CATALOG_AGENTS);
    expect(CATALOG.slice(CATALOG_AGENTS.length).every(e => e.kind === "tool")).toBe(true);
  });

  it("manages Crush, Qwen Code, Goose and Amp by a pinned road with nothing of theirs measured or carried yet", () => {
    const added = ["crush", "qwen", "goose", "amp"].map(id => catalogEntry(id) as AgentEntry);
    for (const a of added) {
      expect(a.source, a.id).toEqual({ sessions: 0, images: 0, road: "unmeasured" });
      expect(a.projectState, a.id).toEqual([]);
      expect(a.configPaths, a.id).toEqual([]);
      expect(a.signIn, a.id).toEqual(NO_SIGN_IN);
      expect(a.mcp, a.id).toBeUndefined();
      expect(runsThreads(a.id), a.id).toBe(false);
    }
    // A release road carries the tag and both arches' assets with their sums, off the pins table.
    for (const [id, repo] of [["crush", "charmbracelet/crush"], ["goose", "aaif-goose/goose"]] as const) {
      const pin = RELEASE_PINS[repo]!;
      expect(catalogEntry(id)!.installRoad, id).toEqual({ road: "release", repo, version: pin.tag, assets: pin.assets });
      expect(pin.assets.x86_64?.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.assets.aarch64?.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(installLine(catalogEntry(id)!), id).toContain('sha256sum -c -');
    }
    expect(RELEASE_PINS["charmbracelet/crush"]!.assets.x86_64).toEqual({ name: "crush_0.96.1_Linux_x86_64.tar.gz", sha256: "5411b0906a82162dcab4a99071d70accf1caad0eee69789416dd607943c6680d" });
    expect(installShown(catalogEntry("crush")!)).toEqual({ words: "the v0.96.1 release of github.com/charmbracelet/crush" });
    expect(installShown(catalogEntry("goose")!)).toEqual({ words: "the v1.52.0 release of github.com/aaif-goose/goose" });
    // Goose moved to the AAIF at the Linux Foundation: github.com/block/goose only redirects there, and the assets are the same bytes.
    expect(RELEASE_PINS["block/goose"]).toBeUndefined();
    expect(RELEASE_PINS["aaif-goose/goose"]!.assets.x86_64).toEqual({ name: "goose-x86_64-unknown-linux-gnu.tar.gz", sha256: "4aee1f770b405c44194c0e9407df1fb06bda4c50eee935f0d8fd10731821cc5e" });
    expect(RELEASE_PINS["aaif-goose/goose"]!.assets.aarch64).toEqual({ name: "goose-aarch64-unknown-linux-gnu.tar.gz", sha256: "ae602c4f6e9a785bf087da52c89908d4dc6aa605dcc17bf83293873f626d9c85" });
    expect(installLine(catalogEntry("goose")!)).toContain("https://github.com/aaif-goose/goose/releases/download/v1.52.0/");
    expect((catalogEntry("goose") as AgentEntry).about.repo).toBe("https://github.com/aaif-goose/goose");
    expect(installShown(catalogEntry("qwen")!)).toEqual({ line: "npm install -g --ignore-scripts @qwen-code/qwen-code@0.24.5" });
    expect(installShown(catalogEntry("amp")!)).toEqual({ line: "npm install -g @ampcode/cli@0.0.1790352060-g26b83c" });
    expect((catalogEntry("qwen") as AgentEntry).node).toBe(22);
    expect(catalogEntry("crush")!.size).toEqual({ bytes: 86818976, on: "2026-09-26", method: "unpacked" });
    expect(sizeBytes(catalogEntry("amp")!.size)).toBeUndefined();
    // Every folder an install writes a skill into is one of the agent's own, under the home.
    for (const a of added) for (const r of a.skillRoots.user) expect(r.dir, a.id).toMatch(/^~\//);
  });

  it("says which agents wsp opens threads on", () => {
    expect(CATALOG_AGENTS.filter(a => runsThreads(a.id)).map(a => a.id)).toEqual([...THREAD_AGENTS]);
    expect(runsThreads("nope")).toBe(false);
  });

  it("says where each agent's newest version is published: its own npm package or release, or the vendor's own answer", () => {
    expect(CATALOG_AGENTS.map(a => [a.id, a.latest?.from])).toEqual([
      ["claude", "text"],
      ["codex", "npm"],
      ["gemini", "npm"],
      ["opencode", "npm"],
      ["pi", "npm"],
      // Its releases are tagged by date while its binary prints a semver first, so the two are never compared.
      ["hermes", undefined],
      ["crush", "github"],
      ["qwen", "npm"],
      ["goose", "github"],
      ["amp", "npm"],
    ]);
    for (const a of CATALOG_AGENTS) {
      const [road, latest] = [a.installRoad, a.latest];
      if (latest?.from === "npm") expect(road.road === "npm" ? road.package : undefined, a.id).toBe(latest.package);
      if (latest?.from === "github") expect(road.road === "release" ? road.repo : undefined, a.id).toBe(latest.repo);
      if (latest?.from === "text") expect(latest.url, a.id).toMatch(/^https:\/\//);
    }
  });

  it("says who makes each agent, what it is in a sentence or two, its license, where it lives, and the line a person pastes to install it", () => {
    expect(CATALOG_AGENTS.map(a => [a.id, a.about.creator, a.about.license])).toEqual([
      ["claude", "Anthropic", "proprietary"],
      ["codex", "OpenAI", "Apache-2.0"],
      ["gemini", "Google", "Apache-2.0"],
      ["opencode", "Anomaly", "MIT"],
      ["pi", "Earendil Works", "MIT"],
      ["hermes", "Nous Research", "MIT"],
      ["crush", "Charm", "FSL-1.1-MIT"],
      ["qwen", "Qwen team, Alibaba", "Apache-2.0"],
      ["goose", "Block", "Apache-2.0"],
      ["amp", "Sourcegraph", "proprietary"],
    ]);
    for (const a of CATALOG_AGENTS) {
      const sentences = a.about.description.split(/(?<=\.) /);
      expect(sentences.length, a.id).toBeLessThanOrEqual(2);
      for (const s of sentences) expect(s, a.id).toMatch(/^[A-Z].*\.$/);
      expect(a.about.description, a.id).not.toMatch(/\bAI\b/);
      if (a.about.repo !== undefined) expect(a.about.repo, a.id).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
      if (a.about.homepage !== undefined) expect(a.about.homepage, a.id).toMatch(/^https:\/\//);
    }
    // Amp's source is not public.
    expect(CATALOG_AGENTS.filter(a => a.about.repo === undefined).map(a => a.id)).toEqual(["amp"]);
    expect(installShown(catalogEntry("codex")!)).toEqual({ line: "npm install -g @openai/codex@0.153.0" });
    // A vendor's script is many lines no person pastes, and a release is a download checked against its sum.
    expect(installShown(catalogEntry("claude")!)).toEqual({ words: "by its own installer" });
    expect(installShown(catalogEntry("hermes")!)).toEqual({ words: "by its own installer" });
    expect(installShown(catalogEntry("gh")!)).toEqual({ words: "the v2.101.0 release of github.com/cli/cli" });
    expect(installShown(catalogEntry("gcloud")!)).toEqual({ words: "Google's Linux release" });
  });

  it("gives every entry one install line from its road's module: apt, npm, Homebrew as linuxbrew, a release at its current tag, a vendor's download", () => {
    expect(installLine(catalogEntry("git")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq git");
    // Bookworm has docker.io but no compose v2 package, so compose comes as the cli plugin from its release, checksummed.
    expect(installLine(catalogEntry("docker")!)).toBe(
      [
        "export DEBIAN_FRONTEND=noninteractive",
        "apt-get install -y -qq docker.io",
        'arch="$(uname -m)"',
        'case "$arch" in',
        "  x86_64) sha=db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576 ;;",
        "  aarch64) sha=732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7 ;;",
        '  *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
        "esac",
        'curl -o /tmp/docker-compose "https://github.com/docker/compose/releases/download/v5.5.1/docker-compose-linux-$arch"',
        'echo "$sha  /tmp/docker-compose" | sha256sum -c - >/dev/null',
        "install -D -m 0755 /tmp/docker-compose /usr/libexec/docker/cli-plugins/docker-compose",
        "rm -f /tmp/docker-compose",
      ].join("\n"),
    );
    // Rust comes by rustup, whose installer is pinned to the sha256 rust-lang publishes beside the archived release.
    // The script road runs every one of these under set -e, so no script carries the line itself.
    expect(installLine(catalogEntry("rust")!)).toBe(
      [
        'arch="$(uname -m)"',
        'case "$arch" in',
        "  x86_64) sha=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71 ;;",
        "  aarch64) sha=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433 ;;",
        '  *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
        "esac",
        'curl -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/1.29.1/$arch-unknown-linux-gnu/rustup-init"',
        'echo "$sha  /tmp/rustup-init" | sha256sum -c - >/dev/null',
        "chmod +x /tmp/rustup-init",
        "/tmp/rustup-init -y --no-modify-path --profile default --default-toolchain stable",
        "rm -f /tmp/rustup-init",
      ].join("\n"),
    );
    expect(installLine(catalogEntry("pnpm")!)).toBe("npm install -g pnpm@11.9.0");
    expect(installLine(catalogEntry("wrangler")!)).toBe("npm install -g wrangler");
    expect(installLine(catalogEntry("go")!)).toMatch(/^su -s \/bin\/bash linuxbrew -c 'cd \.[\s\S]*HOMEBREW_NO_AUTO_UPDATE=1[\s\S]*brew install go'$/);
    // A catalog row on the release road downloads the asset the pins table names, at the tag it names, and checks
    // the sum beside it before anything is unpacked: no API read, no listing grepped, no release fetched by date.
    const gh = installLine(catalogEntry("gh")!);
    const pin = RELEASE_PINS["cli/cli"]!;
    expect(gh).toContain("name='gh'");
    expect(gh).toContain(`tag='${pin.tag}'`);
    expect(gh).toContain(`case "$arch" in x86_64) asset='${pin.assets.x86_64!.name}' sha=${pin.assets.x86_64!.sha256} ;; aarch64) asset='${pin.assets.aarch64!.name}' sha=${pin.assets.aarch64!.sha256} ;;`);
    expect(gh).toContain(`url='https://github.com/cli/cli/releases/download/${pin.tag}/'"$asset"`);
    expect(gh.indexOf('echo "$sha  $tmp/$asset" | sha256sum -c - >/dev/null')).toBeLessThan(gh.indexOf('tar -xzf "$tmp/$asset"'));
    expect(gh).toContain('echo "WSP_ROAD release $asset $sha $tag"');
    expect(gh).not.toContain("api.github.com");
    expect(gh).not.toContain("browser_download_url");
    // Every arch the table names an asset for leaves no fall-through to render: go is the road for an arch with none.
    expect(gh).not.toContain("go install");
    expect(gh).not.toContain("command -v go");
    // An arch the release has no asset for takes the row's main package at the tag, and is refused where it names none.
    const armless = ROAD_MODULES.release.install({ road: "release", repo: "cli/cli", version: "v2.86.0", assets: { x86_64: { name: "gh_linux_amd64.tar.gz", sha256: "e".repeat(64) } }, go: "github.com/cli/cli/v2/cmd/gh" }, "gh") as string;
    expect(armless).toContain("aarch64) asset= sha= ;;");
    expect(armless).toContain("go install 'github.com/cli/cli/v2/cmd/gh@v2.86.0'");
    const noGo = ROAD_MODULES.release.install({ road: "release", repo: "cli/cli", version: "v2.86.0", assets: { x86_64: { name: "gh_linux_amd64.tar.gz", sha256: "e".repeat(64) } } }, "gh") as string;
    expect(noGo).not.toContain("go install");
    expect(noGo).toContain(`echo "Error: release "'v2.86.0'" of "'cli/cli'" has no Linux build for $arch" >&2`);
    // A release road with no tag installs nothing: nothing in the catalog fetches the current release any more.
    expect(ROAD_MODULES.release.install({ road: "release", repo: "cli/cli" }, "gh")).toEqual({ note: "names no release tag; name the version" });
    expect(gh).not.toContain('[ "$sum" =');
    expect(installLine(catalogEntry("gcloud")!)).toBe(GCLOUD.install);
    expect(installLine(catalogEntry("kubectl")!)).toBe(KUBECTL.install);
    // The floor runs before Homebrew or the release machinery exist on the machine.
    for (const e of BASE_FLOOR) expect(["brew", "release", "vendor"], e.id).not.toContain(e.installRoad.road);
  });

  it("says which managers the build reads a row's road off: every package manager a collector files rows under, and no road that carries none", () => {
    // The collector files a tools row under a manager's name, and the plan reads that row's road off the module.
    for (const road of ["brew", "npm", "pnpm", "bun", "uv", "pipx", "cargo", "go"]) expect(readsRowRoad(road), road).toBe(true);
    // apt is on every machine and brings no row of its own, so a row filed under it installs nothing: the catalog
    // row of a tool apt carries is what installs it, and the collector and the recipe verb read this to know.
    for (const road of ["apt", "release", "vendor", "script"]) expect(readsRowRoad(road), road).toBe(false);
    expect(readsRowRoad("snap")).toBe(false);
  });

  it("has one module per road with its words, and each module writes the install and its uninstall twin from a row", () => {
    expect(Object.keys(ROAD_MODULES).sort()).toEqual([...ROADS].sort());
    for (const road of ROADS) expect(ROAD_MODULES[road].words, road).toMatch(/^(by|with|as|from) /);
    const line = (road: InstallRoad, bin = "x") => roadModule(road).install(road, bin);
    const off = (road: InstallRoad, bin = "x") => roadModule(road).uninstall(road, bin);
    const row = (name: string, version?: string) => ({ name, ...(version !== undefined ? { version } : {}), paths: [], label: name });
    const npm = ROAD_MODULES.npm.fromRow!(row("bun", "1.4.0"));
    expect([line(npm), off(npm)]).toEqual(["npm install -g bun@1.4.0", { cmd: "npm uninstall -g bun" }]);
    expect(line({ road: "npm", package: "@earendil-works/pi-coding-agent", version: "0.84.4", ignoreScripts: true })).toBe("npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4");
    const pnpm = ROAD_MODULES.pnpm.fromRow!(row("turbo", "2.5.0"));
    expect([line(pnpm), off(pnpm)]).toEqual(["pnpm add -g turbo@2.5.0", { cmd: "pnpm remove -g turbo" }]);
    const bun = ROAD_MODULES.bun.fromRow!(row("eslint"));
    expect([line(bun), off(bun)]).toEqual(["bun add -g eslint", { cmd: "bun remove -g eslint" }]);
    const uv = ROAD_MODULES.uv.fromRow!(row("ty", "0.0.56"));
    expect([line(uv), off(uv)]).toEqual(["uv tool install ty==0.0.56", { cmd: "uv tool uninstall ty" }]);
    const pipx = ROAD_MODULES.pipx.fromRow!(row("black", "24.1.0"));
    expect([line(pipx), off(pipx)]).toEqual(["pipx install black==24.1.0", { cmd: "pipx uninstall black" }]);
    // --locked takes the dependency set the crate's own lockfile names, so two builders a month apart build the same tool.
    expect(line(ROAD_MODULES.cargo.fromRow!(row("bat", "0.24.0")))).toBe("cargo install bat --version 0.24.0 --locked");
    expect([line(ROAD_MODULES.cargo.fromRow!(row("bat"))), off(ROAD_MODULES.cargo.fromRow!(row("bat")))]).toEqual(["cargo install bat --locked", { cmd: "cargo uninstall bat" }]);
    // A Go row carries its module in its first path (or an older label); the row's version wins over the module's; no module, nothing to run.
    const gopls = ROAD_MODULES.go.fromRow!({ name: "gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"], label: "gopls" });
    expect([line(gopls), ROAD_MODULES.go.bin!(gopls), off(gopls)]).toEqual(["go install golang.org/x/tools/gopls@v0.16.2", "gopls", { note: "go has no uninstall; the binary stays in /root/go/bin" }]);
    expect(line(ROAD_MODULES.go.fromRow!({ name: "gopls", version: "v0.17.0", paths: ["golang.org/x/tools/gopls@v0.16.2"], label: "gopls" }))).toBe("go install golang.org/x/tools/gopls@v0.17.0");
    expect(line(ROAD_MODULES.go.fromRow!({ name: "gopls", paths: [], label: "gopls (golang.org/x/tools/gopls@v0.16.2)" }))).toBe("go install golang.org/x/tools/gopls@v0.16.2");
    expect(ROAD_MODULES.go.bin!(ROAD_MODULES.go.fromRow!({ name: "spoo", paths: ["github.com/spoo-me/spoo/v2@v2.0.0"], label: "spoo" }))).toBe("spoo");
    const junk = ROAD_MODULES.go.fromRow!({ name: "junk", paths: [], label: "junk (no module info)" });
    expect([junk, line(junk), ROAD_MODULES.go.bin!(junk)]).toEqual([{ road: "go" }, { note: "no module to install from" }, undefined]);
    // Homebrew runs as its own user; a tap formula that took the road comes off from /usr/local/bin when the cellar never had it.
    const gh = ROAD_MODULES.brew.fromRow!(row("gh"));
    // su keeps the caller's folder, and root's home is one linuxbrew cannot read on some images: every brew moves
    // off such a folder before it runs, and stays where it was called when that folder can be read.
    expect(line(gh)).toMatch(/^su -s \/bin\/bash linuxbrew -c 'cd \. 2>\/dev\/null \|\| cd \/home\/linuxbrew\nHOMEBREW_NO_AUTO_UPDATE=1 .*brew install gh'$/);
    expect(off(gh)).toEqual({ cmd: expect.stringMatching(/brew uninstall gh'$/) });
    expect(off({ road: "brew", formula: "zingzy/tap/diskbloom" })).toEqual({ cmd: expect.stringMatching(/^if \[ -x \/home\/linuxbrew\/.linuxbrew\/bin\/brew \] && su [\s\S]*brew list --formula zingzy\/tap\/diskbloom[\s\S]* >\/dev\/null 2>&1; then su [\s\S]*brew uninstall zingzy\/tap\/diskbloom[\s\S]*; else rm -f \/usr\/local\/bin\/'diskbloom'; fi$/) });
    // A release at a tag fetches that tag and prints it; with a pin for the same tag the sum is checked; a row that names no repository only comes off.
    const tagged = line({ road: "release", repo: "spoo-me/spoo-cli", version: "v0.4.1", go: "github.com/spoo-me/spoo-cli" }, "spoo");
    expect(tagged).toContain(`release="$(curl 'https://api.github.com/repos/spoo-me/spoo-cli/releases/tags/v0.4.1' || true)"`);
    expect(tagged).not.toContain("tag=\"$(");
    expect(tagged).toContain("tag='v0.4.1'");
    expect(tagged).toContain('echo "WSP_ROAD release $asset $sum $tag"');
    // A bare module goes in at the tag; one that carries its own version keeps it; a road with none has no go branch.
    expect(tagged).toContain("go install 'github.com/spoo-me/spoo-cli@v0.4.1'");
    expect(tagged).toContain(`echo "Error: release "'v0.4.1'" of "'spoo-me/spoo-cli'" has no Linux build, and go is not on the machine" >&2`);
    expect(line({ road: "release", repo: "spoo-me/spoo-cli", version: "v0.4.1", go: "github.com/spoo-me/spoo-cli@v0.4.0" }, "spoo")).toContain("go install 'github.com/spoo-me/spoo-cli@v0.4.0'");
    expect(line({ road: "release", repo: "spoo-me/spoo-cli", version: "v0.4.1" }, "spoo")).not.toContain("command -v go");
    // A road that pins a version takes a row's through at(); Homebrew, apt and a script install what their source serves and have none.
    expect(ROAD_MODULES.npm.at!({ road: "npm", package: "wrangler" }, "4.1.0")).toEqual({ road: "npm", package: "wrangler", version: "4.1.0" });
    expect(ROAD_MODULES.cargo.at!({ road: "cargo", package: "bat", version: "0.23.0" }, "0.24.0")).toEqual({ road: "cargo", package: "bat", version: "0.24.0" });
    // The release and vendor roads take no version from a row: each installs the artifact the catalog pinned, so a
    // recipe's own version moves nothing and the row is noted instead.
    for (const road of ["npm", "pnpm", "bun", "uv", "pipx", "cargo", "go"] as const) expect(ROAD_MODULES[road].at, road).toBeDefined();
    for (const road of ["brew", "apt", "script", "release", "vendor"] as const) expect(ROAD_MODULES[road].at, road).toBeUndefined();
    expect(line({ road: "release", repo: "spoo-me/spoo-cli", version: "v0.4.1", pin: { tag: "v0.4.1", sha256: "c".repeat(64) } }, "spoo")).toContain(`[ "$sum" = '${"c".repeat(64)}' ]`);
    expect(line({ road: "release", repo: "spoo-me/spoo-cli", version: "v0.4.1", pin: { tag: "v0.4.0", sha256: "c".repeat(64) } }, "spoo")).not.toContain('[ "$sum" =');
    // No version: a pin fixes the tag and is checked, as a vendor install does; with neither there is no release to read and the row is noted.
    expect(line({ road: "release", repo: "cli/cli", pin: { tag: "v2.86.0", sha256: "d".repeat(64) } }, "gh")).toContain("releases/tags/v2.86.0");
    expect(line({ road: "release", repo: "cli/cli", pin: { tag: "v2.86.0", sha256: "d".repeat(64) } }, "gh")).toContain(`[ "$sum" = '${"d".repeat(64)}' ]`);
    expect(line({ road: "release" }, "spoo")).toEqual({ note: "no GitHub release to install from" });
    expect(off({ road: "release" }, "spoo")).toEqual({ cmd: "rm -f /usr/local/bin/'spoo'" });
    // A vendor's download is the cask's own script, whatever version the row carries.
    const gcloud: InstallRoad = { road: "vendor", cask: GCLOUD, version: "575.0.0" };
    expect([line(gcloud), off(gcloud), ROAD_MODULES.vendor.bin!(gcloud)]).toEqual([GCLOUD.install, { cmd: GCLOUD.uninstall }, "gcloud"]);
    const kubectl: InstallRoad = { road: "vendor", cask: KUBECTL, pin: { tag: "v1.37.0", sha256: "c".repeat(64) } };
    expect(line(kubectl)).toBe(KUBECTL.install);
    // A cask's own sum rides every install of it, so the bytes are checked whether or not a recipe recorded a pin.
    expect(line(kubectl)).toContain(KUBECTL.sha256.x86_64);
    // apt rows wait on the one index read; purge takes what the package alone pulled in.
    const apt: InstallRoad = { road: "apt", packages: ["neovim"] };
    expect([line(apt), off(apt), ROAD_MODULES.apt.after]).toEqual(["export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq neovim", { cmd: "export DEBIAN_FRONTEND=noninteractive\napt-get purge -y -qq neovim && apt-get autoremove -y -qq --purge" }, APT_INDEX]);
    expect(APT_UPDATE).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get update -qq");
    expect([ROAD_MODULES.brew.after, ROAD_MODULES.npm.after]).toEqual([HOMEBREW_STEP, "node"]);
    expect([line({ road: "script", script: "echo hi" }), off({ road: "script", script: "echo hi" }, "hi")]).toEqual(["echo hi", { note: "hi has no uninstaller; left on the machine" }]);
  });

  it("each module says the one line a person reads for an install whose script is not that line; the rest read as their command", () => {
    const shown = (road: InstallRoad, bin = "x") => roadModule(road).shown?.(road, bin);
    expect(shown({ road: "brew", formula: "gh" })).toBe("brew install gh");
    expect(shown({ road: "apt", packages: ["neovim", "fd-find"] })).toBe("apt-get install neovim fd-find");
    expect(shown({ road: "release", repo: "cli/cli" }, "gh")).toBe("names no release tag; name the version");
    expect(shown({ road: "release", repo: "cli/cli", version: "v2.86.0" }, "gh")).toBe("the v2.86.0 release of github.com/cli/cli");
    expect(shown({ road: "release", repo: "cli/cli", pin: { tag: "v2.86.0", sha256: "d".repeat(64) } }, "gh")).toBe("the v2.86.0 release of github.com/cli/cli");
    expect(shown({ road: "vendor", cask: GCLOUD })).toBe(GCLOUD.from);
    for (const road of ["npm", "pnpm", "bun", "uv", "pipx", "cargo", "go", "script"] as const) expect(ROAD_MODULES[road].shown, road).toBeUndefined();
  });

  it("installs every road inside a tree a workspace on a computer somebody owns can see: an overlaid tree, the machine's home, or a shared tool root", () => {
    // Found on spoo, 2026-09-18: gh and every other Homebrew row was on the box and in no workspace of it, because
    // /home/linuxbrew is outside the trees a workspace overlays and outside the /root it binds, while the PATH
    // inside named the prefix all the same. A road that installs somewhere else is the same bug, so every road
    // says where it installs and this holds the lot of them to what a workspace can see.
    expect(Object.keys(ROAD_MODULES).sort()).toEqual([...ROADS].sort());
    const visible = [...WORKSPACE_OVERLAID, GUEST_HOME, ...SHARED_TOOL_ROOTS];
    for (const road of ROADS) {
      const roots = ROAD_MODULES[road].roots;
      expect(roots.length, road).toBeGreaterThan(0);
      for (const root of roots) {
        expect(root.startsWith("/"), `${road} installs into ${root}, which is no absolute path`).toBe(true);
        const under = visible.filter(tree => root === tree || root.startsWith(`${tree}/`));
        expect(under, `${road} installs into ${root}, which no workspace on a computer somebody owns can see: it belongs under ${visible.join(", ")}, or the protocol's SHARED_TOOL_ROOTS gains its root and the daemon binds it in`).not.toEqual([]);
      }
    }
    // And every shared tool root is on the one PATH a machine's tools sit on: a root brought into a workspace whose
    // bin directories nothing names is a prefix no command is found in.
    for (const root of SHARED_TOOL_ROOTS) expect(TOOLS_PATH.split(":").some(dir => dir.startsWith(`${root}/`)), root).toBe(true);
    // The formula road's own prefix is that root, read from the protocol by both sides.
    expect(BREW_PREFIX.startsWith(`${SHARED_TOOL_ROOTS[0]}/`)).toBe(true);
  });

  it("names the directories each script links its commands into, on the script row that carries it", () => {
    // Six of the catalogue's scripts link into /usr/local/bin and two do not, so one directory on the road module
    // would put a false note on every box's rust and docker rows. The directories sit on each script's own row and
    // the module reads them off it.
    const scriptBins = (id: string): readonly string[] | undefined => {
      const road = (catalogEntry(id) as ToolEntry | AgentEntry | undefined)?.installRoad;
      return road?.road === "script" ? road.bins : undefined;
    };
    for (const id of ["node", "uv", "python", "fd", "yarn", "claude"]) expect(scriptBins(id), id).toEqual(["/usr/local/bin"]);
    expect(scriptBins("docker")).toEqual(["/usr/bin"]);
    expect(scriptBins("rust")).toEqual([`${GUEST_HOME}/.cargo/bin`]);
    // A script whose row names none says nothing, which is a row that gets no note rather than a wrong one.
    expect(scriptBins("hermes")).toBeUndefined();
  });

  it("gives every road a step: how long it may run, whether a run that hit the limit is tried once more, and the lines that clock its network reads", () => {
    expect(Object.keys(ROAD_STEPS).sort()).toEqual([...ROADS].sort());
    // A dead read fails in about a minute and is tried once more, on every road whose tool takes the knobs from its environment.
    expect([NET_READ_S, NET_RETRIES]).toEqual([60, 1]);
    const env = (road: keyof typeof ROAD_STEPS) => ROAD_STEPS[road].env.join("\n");
    expect(env("npm")).toBe("export npm_config_fetch_timeout=60000 npm_config_fetch_retries=1 npm_config_fetch_retry_maxtimeout=10000");
    expect(env("pnpm")).toBe(env("npm"));
    expect(env("pipx")).toBe("export PIP_TIMEOUT=60 PIP_RETRIES=1");
    expect(env("uv")).toBe("export UV_HTTP_TIMEOUT=60 UV_HTTP_RETRIES=1");
    expect(env("cargo")).toBe("export CARGO_HTTP_TIMEOUT=60 CARGO_NET_RETRY=1");
    expect(env("release")).toBe(CURL_NET);
    expect(env("vendor")).toBe(CURL_NET);
    // A script may run any of them, so it gets every line; Homebrew takes its retry count from its own environment.
    // A script road's step is a whole script whose last line may be a cleanup, so the road runs it under set -e: a
    // failed download must not read as an install on a machine that already carries the tool.
    expect(ROAD_STEPS.script.env).toEqual(["set -euo pipefail", ...ROAD_STEPS.npm.env, ...ROAD_STEPS.pipx.env, ...ROAD_STEPS.uv.env, ...ROAD_STEPS.cargo.env, CURL_NET]);
    for (const road of ROADS) expect(ROAD_STEPS[road].env.includes("set -euo pipefail"), road).toBe(road === "script");
    expect(BREW_ENV).toContain("HOMEBREW_CURL_RETRIES=1");
    for (const road of ["brew", "bun", "go", "apt"] as const) expect(ROAD_STEPS[road].env, road).toEqual([]);
    // Package managers and downloads get a shorter step than anything that may compile; a download that ran the clock out is tried once more, a compile is not.
    const downloads = ["npm", "pnpm", "bun", "uv", "pipx", "release", "vendor"] as const;
    for (const road of downloads) expect(ROAD_STEPS[road], road).toMatchObject({ limitS: 300, retry: true });
    for (const road of ["brew", "go", "apt", "script"] as const) expect(ROAD_STEPS[road], road).toMatchObject({ limitS: 600, retry: false });
    expect(ROAD_STEPS.cargo).toMatchObject({ limitS: 1200, retry: false });
  });

  it("the curl every road script types goes through one function that clocks the connection and a dead read, tries once more, and fails loud on an HTTP error", () => {
    // The function runs under this machine's bash, ahead of a curl stand-in on PATH that prints what reached it.
    const dir = mkdtempSync(join(tmpdir(), "wsp-curl-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "curl"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const out = execFileSync("bash", ["-c", `${CURL_NET}\ncurl -o /tmp/x 'https://example.test/a b'`], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}` } });
    // --silent drops the progress meter from stderr; --show-error keeps the one error line the reason rule reads.
    expect(out.split("\n").filter(l => l !== "")).toEqual(["--connect-timeout", "15", "--speed-limit", "1", "--speed-time", "60", "--retry", "1", "--fail", "--silent", "--show-error", "--location", "-o", "/tmp/x", "https://example.test/a b"]);
  });

  it("the default agent is the vendor's own binary at a pinned version, checked against the sums its manifest publishes, and no road runs a vendor installer", () => {
    // The image's setup takes off the file an image sealed before held under the home, first on its PATH; the row's
    // script names no folder under the home, since a box shares that home with every workspace on it.
    expect(catalog.GOLDEN_SETUP).toBe(`rm -f /root/.local/bin/claude\n${catalog.CLAUDE_INSTALL}`);
    expect(catalog.CLAUDE_CODE.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(catalog.CLAUDE_INSTALL).toBe([
      'arch="$(uname -m)"',
      'case "$arch" in',
      `  x86_64) plat=linux-x64 sha=${catalog.CLAUDE_CODE.sha256.x86_64} ;;`,
      `  aarch64) plat=linux-arm64 sha=${catalog.CLAUDE_CODE.sha256.aarch64} ;;`,
      '  *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
      "esac",
      "trap 'rm -f /tmp/claude' EXIT",
      `curl -o /tmp/claude "https://downloads.claude.ai/claude-code-releases/${catalog.CLAUDE_CODE.version}/$plat/claude"`,
      'echo "$sha  /tmp/claude" | sha256sum -c - >/dev/null',
      `install -D -m 0755 /tmp/claude ${LOCAL_BIN}/claude`,
    ].join("\n"));
    for (const arch of ["x86_64", "aarch64"] as const) expect(catalog.CLAUDE_CODE.sha256[arch], arch).toMatch(/^[0-9a-f]{64}$/);
    // The row installs into the one directory it names, at the version its own text fixes, so a copy gets that version.
    const claude = catalogEntry("claude")!;
    const road = claude.installRoad;
    expect(road).toEqual({ road: "script", script: catalog.CLAUDE_INSTALL, version: catalog.CLAUDE_CODE.version, bins: [LOCAL_BIN] });
    expect(fixesVersion(road)).toBe(true);
    expect(roadModule(road).bins(road as never)).toEqual([LOCAL_BIN]);
    // A box's job reads the row under its prefix and finds the harness in the same folder, which its PATH holds.
    expect(roadModule(road).bins(road as never, installHomes(TOOL_PREFIX))).toEqual([LOCAL_BIN]);
    // Nothing downloads a script and runs it any more: the module that did is gone with the road.
    expect("installerScript" in catalog).toBe(false);
    for (const e of CATALOG) expect(installLine(e), e.id).not.toMatch(/\bbash "\$f"/);
  });

  it("the agent's install leaves no download behind on a refused sum: it runs here with its target moved and one digit of the sum flipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-agent-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    // A local file stands in for the vendor's 215 MB download, so the refusal is read without touching the network.
    writeFileSync(join(dir, "served"), "not the agent's binary\n");
    const flip = (sha: string) => (sha.startsWith("0") ? "1" : "0") + sha.slice(1);
    const download = join(dir, "download");
    const installed = join(dir, "bin", "claude");
    // The script road's step carries `set -euo pipefail`, pinned above, so a refused sum ends the script where it stands.
    // The arch is forced so the case reads the checksum road on any machine that runs the suite, not the arch word of the machine's own uname.
    const script = `set -euo pipefail\n${catalog.CLAUDE_INSTALL}`
      .replace('arch="$(uname -m)"', "arch=x86_64")
      .replace(`${LOCAL_BIN}/claude`, installed)
      .replaceAll("/tmp/claude", download)
      .replace(`"https://downloads.claude.ai/claude-code-releases/${catalog.CLAUDE_CODE.version}/$plat/claude"`, `"file://${join(dir, "served")}"`)
      .replaceAll(catalog.CLAUDE_CODE.sha256.x86_64, flip(catalog.CLAUDE_CODE.sha256.x86_64))
      .replaceAll(catalog.CLAUDE_CODE.sha256.aarch64, flip(catalog.CLAUDE_CODE.sha256.aarch64));
    const run = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("sha256sum");
    expect(existsSync(download)).toBe(false);
    expect(existsSync(installed)).toBe(false);
  });

  it("no road line spells curl's flags itself: the function is their one home", () => {
    const own = /\bcurl +-[A-Za-z]*[fsSL]\b/;
    const lines = [
      ...CATALOG.map(e => installLine(e)),
      ...LINUX_CASKS.map(c => c.install),
      ROAD_MODULES.release.install({ road: "release", repo: "cli/cli", go: "github.com/cli/cli/v2/cmd/gh" }, "gh"),
      ROAD_MODULES.release.install({ road: "release", repo: "spoo-me/spoo-cli", version: "v0.4.1", pin: { tag: "v0.4.1", sha256: "b".repeat(64) } }, "spoo"),
      catalog.UV_INSTALL,
      catalog.nodeInstallScript(22, catalog.NODE_RELEASES[22]),
      catalog.DOCKER_INSTALL,
    ];
    for (const line of lines) {
      const text = typeof line === "string" ? line : line.note;
      expect(text).not.toMatch(own);
    }
    expect(lines.filter(l => typeof l === "string" && /\bcurl\b/.test(l)).length).toBeGreaterThanOrEqual(8);
  });

  it("names the evidence behind every default: sessions on this Mac and lab images that ship it", () => {
    for (const e of CATALOG) {
      expect(Number.isInteger(e.source.sessions) && e.source.sessions >= 0, e.id).toBe(true);
      expect(e.source.images, e.id).toBeGreaterThanOrEqual(0);
      expect(e.source.images, e.id).toBeLessThanOrEqual(5);
    }
    expect(CATALOG.filter(e => e.kind === "tool" && e.defaultOn).map(e => e.id)).toEqual(["curl", "node", "pnpm", "uv", "python", "git", "jq", "ripgrep", "build-essential", "fd", "sqlite3", "wget", "zip", "xz", "rsync", "gh", "agent-browser"]);
    expect(catalogEntry("agent-browser")?.source.note).toMatch(/one Mac/);
  });

  it("seeds every golden with the base floor: the entries flagged for it, in catalog order, each default-on by a pinned road", () => {
    // curl leads: a base image need not ship one, and every road below that fetches a release types it.
    expect(BASE_FLOOR.map(e => e.id)).toEqual(["curl", "uv", "python", "git", "jq", "ripgrep", "build-essential", "fd", "sqlite3", "wget", "zip", "xz", "rsync"]);
    expect(BASE_FLOOR).toEqual(CATALOG.filter(e => e.kind === "tool" && e.floor));
    for (const e of BASE_FLOOR) {
      expect(e.defaultOn, e.id).toBe(true);
      expect(e.installRoad.road, e.id).not.toBe("release");
      if (e.installRoad.road === "npm") expect(e.installRoad.version, e.id).toBeDefined();
      // A row that waits on another floor row waits on one the catalog lists before it.
      const dep = installAfter(e);
      if (dep !== undefined && dep !== "apt-index") expect(BASE_FLOOR.findIndex(x => x.id === dep), e.id).toBeLessThan(BASE_FLOOR.indexOf(e));
    }
    expect(CATALOG.filter(e => e.kind === "tool" && e.defaultOn && !e.floor).map(e => e.id)).toEqual(["node", "pnpm", "gh", "agent-browser"]);
    // An apt package runs on the index read once, a script on what its entry names.
    expect(BASE_FLOOR.map(e => installAfter(e))).toEqual(["apt-index", "curl", "uv", "apt-index", "apt-index", "apt-index", "apt-index", "apt-index", "apt-index", "apt-index", "apt-index", "apt-index", "apt-index"]);
    // Node and pnpm are rows a recipe ticks: an image whose recipe asks for neither carries no node at all, and the
    // npm road brings node itself where a ticked row walks it.
    const node = catalogEntry("node") as ToolEntry;
    expect([node.floor, node.defaultOn]).toEqual([false, true]);
    expect(node.brings).toEqual([{ bin: "npm", version: "npm --version" }]);
    expect(installAfter(node)).toBe("curl");
    const pnpm = catalogEntry("pnpm") as ToolEntry;
    expect([pnpm.floor, pnpm.defaultOn]).toEqual([false, true]);
    expect(installAfter(pnpm)).toBe("node");
    // Docker is a row a person ticks and never the floor's: half a gigabyte on every image that carries it, and a
    // guest whose kernel has no overlayfs cannot start it. Its engine is by apt, so its script waits on the index
    // read as the apt rows do.
    const docker = catalogEntry("docker") as ToolEntry;
    expect([docker.floor, docker.defaultOn]).toEqual([false, false]);
    expect(docker.brings).toEqual([{ bin: "docker compose", version: "docker compose version" }]);
    expect(docker.installRoad.road).toBe("script");
    expect(installAfter(docker)).toBe(APT_INDEX);
    // Python comes as uv's managed 3.12, pinned by uv's own release, and python3 on PATH is that interpreter.
    const python = catalogEntry("python")!;
    expect(python.installRoad.road).toBe("script");
    expect(python.installRoad.road === "script" && python.installRoad.script).toContain("uv python install 3.12");
    expect(python.installRoad.road === "script" && python.installRoad.script).toContain('ln -sfn "$(uv python find --managed-python 3.12)" /usr/local/bin/python3');
    expect(python.installRoad.road === "script" && python.installRoad.script).toContain("sha256sum -c");
    expect(python.size).toEqual({ bytes: 108105728, on: "2026-09-07", method: "du" });
  });

  it("names the base row a recipe's tools row stands for: by id, command, road argument or a name it covers", () => {
    expect(baseEntryFor("jq")?.id).toBe("jq");
    expect(baseEntryFor("rg")?.id).toBe("ripgrep");
    expect(baseEntryFor("python@3.12")?.id).toBe("python");
    expect(baseEntryFor("python3")?.id).toBe("python");
    // A name a row covers whose row is not on the floor stands for no base row: the tick installs it in the tools
    // stage like any other.
    expect(catalogToolFor("docker-compose")?.id).toBe("docker");
    expect(baseEntryFor("docker-compose")).toBeUndefined();
    expect(catalogToolFor("pnpm")?.id).toBe("pnpm");
    expect(baseEntryFor("pnpm")).toBeUndefined();
    expect(catalogToolFor("node@22")?.id).toBe("node");
    expect(baseEntryFor("node")).toBeUndefined();
    expect(catalogToolFor("node@24")).toBeUndefined();
    expect(baseEntryFor("python@3.14")).toBeUndefined();
    expect(baseEntryFor("git")?.id).toBe("git");
    expect(catalogToolFor("npm")?.id).toBe("node");
    expect(baseEntryFor("npm")).toBeUndefined();
    expect(baseEntryFor("gh")).toBeUndefined();
    expect(baseEntryFor("agent-browser")).toBeUndefined();
  });

  it("a covered row's note names the computer that was read and both majors when it runs another one, and the base row alone otherwise", () => {
    const python = baseEntryFor("python")!;
    expect(baseNote(python, "3.14.0", "darwin")).toBe("Python 3.12 is part of the base; this Mac runs Python 3.14");
    expect(baseNote(python, "v3.12.7", "darwin")).toBe("Python 3.12 is part of the base");
    expect(baseNote(python, undefined, "darwin")).toBe("Python 3.12 is part of the base");
    // A note built on a Linux computer names that computer: the platform read, never the one the sentence was written for.
    expect(baseNote(python, "3.14.0", "linux")).toBe("Python 3.12 is part of the base; this computer runs Python 3.14");
    expect(baseNote(python, "3.12.7", "linux")).toBe("Python 3.12 is part of the base");
    // Only a row that pins a major has one to compare; the rest name the base row whatever version was read here.
    expect(baseNote(baseEntryFor("uv")!, "10.0.0", "darwin")).toBe("uv is part of the base");
    expect(baseNote(baseEntryFor("jq")!, "1.6", "linux")).toBe("jq is part of the base");
  });

  it("says which roads no guest has run yet", () => {
    const unmeasured = CATALOG.filter(e => e.source.road === "unmeasured").map(e => e.id);
    expect(unmeasured).toEqual([
      "crush", "qwen", "goose", "amp",
      "curl", "pnpm", "uv", "python", "git", "jq", "ripgrep", "build-essential", "fd", "sqlite3", "wget", "zip", "xz", "rsync", "gh", "agent-browser",
      "docker", "rust", "maven", "bun", "yarn", "ruff", "black", "mypy", "pyright", "pytest", "prettier", "eslint", "typescript",
      "wrangler", "cloudflared", "kubectl", "aws", "vercel", "netlify", "fly", "supabase", "railway", "doppler", "op", "ffmpeg", "yq", "git-lfs", "tmux",
      "ruby", "php", "postgresql-client", "redis-tools", "golangci-lint", "mise", "git-delta", "shellcheck", "swift", "elixir", "bazel", "llvm", "playwright",
    ]);
    expect(CATALOG_AGENTS.filter(e => e.source.road !== "measured").map(e => e.id)).toEqual(["crush", "qwen", "goose", "amp"]);
  });

  it("gives every row a size in bytes with the day and the way it was measured, or the reason nobody could measure it", () => {
    for (const e of CATALOG) {
      const s = e.size;
      if ("bytes" in s) {
        expect(s.bytes, e.id).toBeGreaterThan(0);
        expect(Number.isInteger(s.bytes), e.id).toBe(true);
        expect(s.on, e.id).toMatch(/^2026-\d\d-\d\d$/);
        expect(Object.keys(SIZE_METHODS), e.id).toContain(s.method);
        expect(sizeBytes(s), e.id).toBe(s.bytes);
      } else {
        expect(s.unmeasured.length, e.id).toBeGreaterThan(20);
        expect(sizeBytes(s), e.id).toBeUndefined();
      }
    }
    // The rows are the one place a size lives: no table of formula or global sizes beside them.
    expect(Object.keys(catalog).filter(k => /_(MIB|BYTES)$/.test(k))).toEqual([]);
    // Every row has a number: 1Password's is its one file unpacked from the deb, since its package carries no Installed-Size.
    // Qwen Code and Amp install by npm, whose bytes only an install could read.
    expect(CATALOG.filter(e => !("bytes" in e.size)).map(e => e.id)).toEqual(["qwen", "amp"]);
    expect(catalogEntry("op")!.size).toEqual({ bytes: 42950840, on: "2026-09-07", method: "unpacked" });
    for (const text of Object.values(SIZE_METHODS)) expect(text).not.toMatch(/\u2014/);
    // The du rows were read on a Debian bookworm host, the node:22-bookworm image among them; the label says the host, not one image.
    expect(SIZE_METHODS.du).toBe("du over what the install wrote, before and after, on a Debian bookworm host");
    for (const e of CATALOG) expect(`${e.name} ${e.source.note ?? ""}`, e.id).not.toMatch(/\u2014/);
    // Every brew row counts its Linux runtime dependencies, so Java carries the ones its bottle links against.
    expect(sizeBytes(catalogEntry("java")!.size)).toBe(613280230);
    // Rust comes by rustup instead of the formula whose Linux bottle pulled llvm@22 in: half the bytes, measured on the machine.
    expect(catalogEntry("rust")!.size).toEqual({ bytes: 1595346944, on: "2026-09-07", method: "du" });
    expect(sizeBytes(catalogEntry("git")!.size)).toBe(123789312);
    expect(catalogEntry("claude")!.size).toEqual({ bytes: 208 * 1024 * 1024, on: "2026-09-05", method: "df" });
  });

  it("carries the tier 1 rows the lab sandboxes ship: the cheap universal ones on the floor, the rest on request", () => {
    // curl leads: a base image need not ship one, and every road below that fetches a release types it.
    expect(BASE_FLOOR.map(e => e.id)).toEqual(["curl", "uv", "python", "git", "jq", "ripgrep", "build-essential", "fd", "sqlite3", "wget", "zip", "xz", "rsync"]);
    expect(installLine(catalogEntry("build-essential")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq build-essential cmake ninja-build");
    expect((catalogEntry("build-essential") as ToolEntry).brings).toEqual([{ bin: "cmake", version: "cmake --version" }, { bin: "ninja", version: "ninja --version" }]);
    expect(catalogToolFor("make")?.id).toBe("build-essential");
    expect(catalogToolFor("gcc")?.id).toBe("build-essential");
    expect(catalogToolFor("cmake")?.id).toBe("build-essential");
    // Debian ships fd as fdfind; the row puts the name agents type on PATH.
    expect(installLine(catalogEntry("fd")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq fd-find\nln -sfn /usr/bin/fdfind /usr/local/bin/fd");
    expect(installAfter(catalogEntry("fd") as ToolEntry)).toBe(APT_INDEX);
    expect(catalogToolFor("fdfind")?.id).toBe("fd");
    expect(catalogToolFor("unzip")?.id).toBe("zip");
    expect(catalogToolFor("xz-utils")?.id).toBe("xz");
    expect((catalogEntry("zip") as ToolEntry).brings).toEqual([{ bin: "unzip", version: "unzip -v" }]);
    const optional = ["bun", "yarn", "ruff", "black", "mypy", "pyright", "pytest", "prettier", "eslint", "typescript"];
    for (const id of optional) {
      const e = catalogEntry(id) as ToolEntry;
      expect(e?.kind, id).toBe("tool");
      expect(e.defaultOn, id).toBe(false);
      expect(e.floor, id).toBe(false);
    }
    expect(installLine(catalogEntry("bun")!)).toBe("npm install -g bun");
    // An exact version, not corepack's moving stable alias: an image built a month later takes the same yarn.
    expect(installLine(catalogEntry("yarn")!)).toBe(`corepack enable yarn\nCOREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install -g yarn@${catalog.YARN_VERSION}`);
    expect(catalog.YARN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installAfter(catalogEntry("yarn") as ToolEntry)).toBe("node");
    expect(installLine(catalogEntry("ruff")!)).toBe("uv tool install ruff");
    expect(installLine(catalogEntry("typescript")!)).toBe("npm install -g typescript");
    expect(catalogEntry("typescript")!.bin).toBe("tsc");
    expect(catalogToolFor("tsc")?.id).toBe("typescript");
    expect(catalogToolFor("bunx")?.id).toBe("bun");
  });

  it("carries the tier 2 and tier 3 rows the lab sandboxes ship and a browser for the web render tests, every one off until asked for", () => {
    const rows = ["ruby", "php", "postgresql-client", "redis-tools", "golangci-lint", "mise", "git-delta", "shellcheck", "swift", "elixir", "bazel", "llvm", "playwright", "op"];
    for (const id of rows) {
      const e = catalogEntry(id) as ToolEntry;
      expect(e?.kind, id).toBe("tool");
      expect([e.defaultOn, e.floor], id).toEqual([false, false]);
      expect(sizeBytes(e.size), id).toBeGreaterThan(0);
    }
    // The apt rows, with what each brings along under its own name.
    expect(installLine(catalogEntry("ruby")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq ruby ruby-dev ruby-bundler");
    expect(catalogToolFor("bundle")?.id).toBe("ruby");
    expect(catalogToolFor("bundler")?.id).toBe("ruby");
    expect(catalogToolFor("gem")?.id).toBe("ruby");
    expect(installLine(catalogEntry("php")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq php-cli composer php-mbstring php-xml php-curl php-zip");
    expect(catalogToolFor("composer")?.id).toBe("php");
    expect(catalogToolFor("psql")?.id).toBe("postgresql-client");
    expect(catalogToolFor("pg_dump")?.id).toBe("postgresql-client");
    expect(catalogToolFor("redis-cli")?.id).toBe("redis-tools");
    expect(catalogToolFor("redis")?.id).toBe("redis-tools");
    expect(installLine(catalogEntry("shellcheck")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq shellcheck");
    expect(installLine(catalogEntry("elixir")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq elixir");
    expect(catalogToolFor("erlang")?.id).toBe("elixir");
    expect(catalogToolFor("mix")?.id).toBe("elixir");
    expect(installLine(catalogEntry("llvm")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq clang clang-format clang-tidy");
    expect(catalogToolFor("clang-tidy")?.id).toBe("llvm");
    for (const id of ["ruby", "php", "postgresql-client", "redis-tools", "shellcheck", "elixir", "llvm"]) expect(installAfter(catalogEntry(id) as ToolEntry), id).toBe(APT_INDEX);
    // The release rows: each repository's pinned Linux asset, downloaded from the tag's own address and checked.
    expect(installLine(catalogEntry("golangci-lint")!)).toContain("url='https://github.com/golangci/golangci-lint/releases/download/v2.13.2/'\"$asset\"");
    expect(installLine(catalogEntry("mise")!)).toContain("asset='mise-v2026.9.12-linux-x64'");
    expect(installLine(catalogEntry("git-delta")!)).toContain("name='delta'");
    expect(installLine(catalogEntry("git-delta")!)).toContain("url='https://github.com/dandavison/delta/releases/download/0.19.2/'\"$asset\"");
    // bazelisk goes on PATH under the name agents type, and covers the name it is published under.
    expect(installLine(catalogEntry("bazel")!)).toContain("name='bazel'");
    expect(installLine(catalogEntry("bazel")!)).toContain("asset='bazelisk-linux-amd64'");
    expect(catalogToolFor("bazelisk")?.id).toBe("bazel");
    // Swift from swift.org's Debian 12 tarball, checksummed, under its own prefix, after the apt index its dependencies need.
    const swift = installLine(catalogEntry("swift")!);
    expect(swift.split("\n").slice(0, 2)).toEqual(["export DEBIAN_FRONTEND=noninteractive", "apt-get install -y -qq binutils libicu-dev libcurl4-openssl-dev libedit-dev libsqlite3-dev libncurses-dev libpython3-dev libxml2-dev pkg-config uuid-dev tzdata git gcc libstdc++-12-dev"]);
    expect(swift).toContain('curl -o "/tmp/$pkg" "https://download.swift.org/swift-6.3.3-release/$dir/swift-6.3.3-RELEASE/$pkg"');
    expect(swift).toContain("  x86_64) dir=debian12 sha=19e0c78cad5418ad48bfa87aa20c53ac9ac9996d1695d04dd94f7c7ea4eb133f ;;");
    expect(swift).toContain("  aarch64) dir=debian12-aarch64 sha=ecba8ef87b54a5048d466af500f3169c939a6b8a2cb7c600f76b5184457f293a ;;");
    expect(swift).toContain('echo "$sha  /tmp/$pkg" | sha256sum -c - >/dev/null');
    expect(swift).toContain('tar -xzf "/tmp/$pkg" -C /opt/swift --strip-components=1');
    expect(swift).toContain("ln -sfn /opt/swift/usr/bin/swift /usr/local/bin/swift");
    expect(installAfter(catalogEntry("swift") as ToolEntry)).toBe(APT_INDEX);
    expect(catalogToolFor("swiftc")?.id).toBe("swift");
    // The browser: Playwright's own Chromium at the Playwright the render tests import, on the node its npm road
    // brings; the row answers to the package names a project depends on.
    expect(installLine(catalogEntry("playwright")!)).toBe("export DEBIAN_FRONTEND=noninteractive\nnpm install -g playwright@1.62.1\nplaywright install --with-deps chromium");
    expect(installAfter(catalogEntry("playwright") as ToolEntry)).toBe("node");
    expect(catalogToolFor("chromium")?.id).toBe("playwright");
    // A project's npm dependency lands on a row only through the names the row lists for it: the browser's packages
    // do, a client library named like a server's tools does not, and neither does a command or cover word.
    for (const pkg of ["playwright", "@playwright/test", "playwright-core"]) expect(catalogToolForDependency("npm", pkg)?.id, pkg).toBe("playwright");
    for (const pkg of ["redis", "sqlite", "sqlite3", "chromium", "bun", "eslint", "typescript", "pg"]) expect(catalogToolForDependency("npm", pkg), pkg).toBeUndefined();
    expect(catalogToolForDependency("uv", "playwright")).toBeUndefined();
    // The pinned Playwright is the one the app manifests pin, so the golden's Chromium is the revision the render tests look for.
    for (const app of ["web", "desktop"]) {
      const manifest = JSON.parse(readFileSync(new URL(`../../../apps/${app}/package.json`, import.meta.url), "utf8")) as { devDependencies: Record<string, string> };
      expect(manifest.devDependencies["playwright"], app).toBe(PLAYWRIGHT.version);
    }
    expect(catalogEntry("playwright")!.size).toEqual({ bytes: 1015808000, on: "2026-09-07", method: "du" });
    // 1Password: its repository under its pinned key, that one index read, then the package; the sum is checked before the key is trusted.
    const op = installLine(catalogEntry("op")!);
    expect(op.split("\n")).toEqual([
      "export DEBIAN_FRONTEND=noninteractive",
      "curl -o /usr/share/keyrings/1password-archive-keyring.asc https://downloads.1password.com/linux/keys/1password.asc",
      'echo "f39e7dd9dedc581ced85732832f217e0de5860a3b80279b5af4bc7c6d8157bae  /usr/share/keyrings/1password-archive-keyring.asc" | sha256sum -c - >/dev/null',
      'arch="$(dpkg --print-architecture)"',
      'echo "deb [arch=$arch signed-by=/usr/share/keyrings/1password-archive-keyring.asc] https://downloads.1password.com/linux/debian/$arch stable main" > /etc/apt/sources.list.d/1password.list',
      "apt-get update -qq -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/1password.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0",
      "apt-get install -y -qq 1password-cli",
    ]);
    expect(catalogToolFor("1password-cli")?.id).toBe("op");
  });

  it("pipes a download into a shell on no road: the harness vendor's own installer is saved to a file first", () => {
    expect(CATALOG.filter(e => /curl[^\n]*\|\s*(ba)?sh/.test(installLine(e))).map(e => e.id)).toEqual([]);
  });

  it("carries no token-looking value", () => {
    expect(JSON.stringify(CATALOG, (_k, v: unknown) => (typeof v === "function" ? String(v) : v))).not.toMatch(/gho_|sk-ant|ya29\.|AKIA/);
  });

  it("is the seeded catalog", () => {
    const rows = CATALOG.map(e => ({
      id: e.id,
      kind: e.kind,
      road: e.installRoad.road,
      argument: roadArgument(e.installRoad),
      signIn: e.signIn.kind,
      status: e.signIn.status?.command,
      ...(e.kind === "tool" ? { defaultOn: e.defaultOn, floor: e.floor, ...(e.covers !== undefined ? { covers: e.covers } : {}), ...(e.major !== undefined ? { major: e.major } : {}) } : {}),
      source: e.source,
      size: e.size,
      configPaths: e.configPaths.length,
      ...(e.kind === "agent" ? { projectState: e.projectState.map(p => p.state) } : {}),
    }));
    expect(rows).toMatchSnapshot();
  });
});

type Road = (typeof CATALOG)[number]["installRoad"];
function roadArgument(road: Road): string {
  switch (road.road) {
    case "brew":
      return road.formula;
    case "npm":
    case "pnpm":
    case "bun":
    case "uv":
    case "pipx":
    case "cargo":
      return road.version === undefined ? road.package : `${road.package}@${road.version}`;
    case "go":
      return `${road.module}@${road.version}`;
    case "release":
      return road.repo ?? "";
    case "vendor":
      return road.cask.bin;
    case "apt":
      return road.packages.join(" ");
    case "script":
      return `${road.script.split("\n").length} lines`;
  }
}
