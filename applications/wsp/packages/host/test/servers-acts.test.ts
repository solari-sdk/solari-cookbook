// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CODEX_TOML, GEMINI_SETTINGS_JSON, OPENCODE_JSON } from "@wsp/catalog";
import { nodeHost, type Host } from "@wsp/collect";
import type { ExecResult, Machine } from "@wsp/engine";
import { configChangedRefusal, configHardLinkRefusal, noServerSwitchRefusal, noSuchServerRefusal, serverNameFormatRefusal, serverNameRefusal, serverThereRefusal } from "@wsp/protocol";
import type { AgentsOn } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { agentHome, type AgentHome } from "../../collect/test/agent-home.js";
import { serverTransport, serversActs } from "../src/servers-acts.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): AgentHome & { root: string } {
  const root = mkdtempSync(join(tmpdir(), "wsp-servers-acts-"));
  roots.push(root);
  const at = agentHome(root);
  writeFileSync(join(at.bin, "runuser"), `#!/bin/bash\n[ "$1" = -u ] && [ "$2" = ada ] && [ "$3" = -- ] || exit 9\nshift 3\nexec "$@"\n`);
  chmodSync(join(at.bin, "runuser"), 0o755);
  chmodSync(join(at.home, ".claude.json"), 0o600);
  return { ...at, root };
}

function here(at: AgentHome): Host {
  const live = nodeHost();
  return { ...live, home: at.home };
}

/** A computer's road that runs every line in bash with the fixture's home, stdin included, keeping each line; `root`
 * answers the probe as a Linux box running as root whose home ada owns, `bytes` is a workspace's machine that lands
 * bytes and carries no stdin, and `before` runs ahead of each line it is handed. */
function road(at: AgentHome, o: { root?: boolean; bytes?: boolean; before?: (cmd: string) => void; cut?: (out: string) => string } = {}): { machine: Pick<Machine, "exec" | "id" | "putBytes" | "uploadUrl">; lines: string[] } {
  const lines: string[] = [];
  const env = { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home };
  const machine = {
    id: "m_road",
    uploadUrl: () => Promise.reject(new Error("this backend mints no signed urls")),
    putBytes: async (path: string, bytes: Uint8Array) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    },
    exec: (cmd: string, opts?: { stdin?: Uint8Array }): Promise<ExecResult> => {
      lines.push(cmd);
      if (o.bytes === true && opts?.stdin !== undefined) return Promise.reject(new Error("this road carries no stdin"));
      if (o.root === true && cmd.startsWith("uname -s;")) return Promise.resolve({ exitCode: 0, stdout: ["Linux", "0", "root", "ada", "1", "/root", "/usr/bin:/bin", ""].join("\n"), stderr: "" });
      o.before?.(cmd);
      return new Promise(resolve => {
        const child = execFile("/bin/bash", ["-c", cmd], { env, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (e, stdout, stderr) => {
          resolve({ exitCode: e === null ? 0 : typeof e.code === "number" ? e.code : 1, stdout: o.cut === undefined ? String(stdout) : o.cut(String(stdout)), stderr: String(stderr) });
        });
        child.stdin?.end(opts?.stdin === undefined ? undefined : Buffer.from(opts.stdin));
      });
    },
  };
  return { machine, lines };
}

const HERE: AgentsOn = { kind: "here" };
const json = (path: string): Record<string, Record<string, unknown>> => JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
const mode = (path: string): number => statSync(path).mode & 0o777;
const box = (at: AgentHome, machine: Pick<Machine, "exec">): AgentsOn => ({ kind: "box", machine, login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` } });

describe("adding an MCP server", () => {
  it("writes a command with its variables into Claude Code's file in place, which keeps its mode, and every other key and server as it was", async () => {
    const at = fixture();
    const file = join(at.home, ".claude.json");
    const before = json(file);
    const added = await serversActs({ here: () => here(at) }).add(HERE, { agent: "claude", name: "acme", command: "npx", args: ["-y", "@acme/mcp"], env: { ACME_KEY: "sk-acme-x" } });
    expect(added).toEqual({ file: "~/.claude.json" });
    const after = json(file);
    expect(after.mcpServers).toEqual({ ...before.mcpServers, acme: { command: "npx", args: ["-y", "@acme/mcp"], env: { ACME_KEY: "sk-acme-x" } } });
    expect(after.projects).toEqual(before.projects);
    expect(mode(file)).toBe(0o600);
    expect(existsSync(join(at.home, "SPAWNED"))).toBe(false);
  });

  it("writes an address with its headers into Codex's TOML, the rest of the file byte for byte", async () => {
    const at = fixture();
    const file = join(at.home, ".codex/config.toml");
    const before = readFileSync(file, "utf8");
    await serversActs({ here: () => here(at) }).add(HERE, { agent: "codex", name: "acme", url: "https://mcp.acme.example/mcp", headers: { Authorization: "Bearer tok-acme" } });
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(CODEX_TOML.read(after, at.home).find(s => s.name === "acme")?.transport).toEqual({ kind: "http", url: "https://mcp.acme.example/mcp", headers: { Authorization: "Bearer tok-acme" } });
  });

  it("writes names into another computer's files and hands each value to the vault, never to the file", async () => {
    const at = fixture();
    const vaulted: Record<string, string>[] = [];
    const acts = serversActs({ vault: v => void vaulted.push({ ...v }) });
    await acts.add(box(at, road(at).machine), { agent: "claude", name: "tracker", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_api_TESTONLY", "X-Team": "eng" } });
    await acts.add(box(at, road(at).machine), { agent: "codex", name: "tracker", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_api_TESTONLY" } });
    await acts.add(box(at, road(at).machine), { agent: "codex", name: "notion", command: "npx", args: ["notion-mcp"], env: { NOTION_TOKEN: "ntn_TESTONLY" } });
    const claude = readFileSync(join(at.home, ".claude.json"), "utf8");
    const codex = readFileSync(join(at.home, ".codex/config.toml"), "utf8");
    for (const secret of ["lin_api_TESTONLY", "ntn_TESTONLY"]) {
      expect(claude).not.toContain(secret);
      expect(codex).not.toContain(secret);
    }
    expect(json(join(at.home, ".claude.json")).mcpServers!.tracker).toEqual({ type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${WSP_MCP_TRACKER_AUTHORIZATION}", "X-Team": "${WSP_MCP_TRACKER_X_TEAM}" } });
    expect(codex).toContain('[mcp_servers.tracker]\nbearer_token_env_var = "WSP_MCP_TRACKER_AUTHORIZATION"');
    expect(codex).toContain('[mcp_servers.notion]\nenv_vars = ["NOTION_TOKEN"]');
    expect(vaulted).toEqual([{ WSP_MCP_TRACKER_AUTHORIZATION: "lin_api_TESTONLY", WSP_MCP_TRACKER_X_TEAM: "eng" }, { WSP_MCP_TRACKER_AUTHORIZATION: "lin_api_TESTONLY" }, { NOTION_TOKEN: "ntn_TESTONLY" }]);
  });

  it("refuses a value for a variable a catalog row keeps its key under, naming the row, and writes nothing", async () => {
    const at = fixture();
    const before = readFileSync(join(at.home, ".codex/config.toml"), "utf8");
    const vaulted: Record<string, string>[] = [];
    await expect(serversActs({ vault: v => void vaulted.push({ ...v }) }).add(box(at, road(at).machine), { agent: "codex", name: "gem", command: "gem-mcp", env: { GEMINI_API_KEY: "gem_TESTONLY" } })).rejects.toThrow(
      "GEMINI_API_KEY belongs to the Gemini CLI key, so set it there or give the variable another name.",
    );
    expect(readFileSync(join(at.home, ".codex/config.toml"), "utf8")).toBe(before);
    expect(vaulted).toEqual([]);
  });

  it("refuses a value for another computer where the host wired no vault to hold it, and writes nothing", async () => {
    const at = fixture();
    const before = readFileSync(join(at.home, ".claude.json"), "utf8");
    await expect(serversActs().add(box(at, road(at).machine), { agent: "claude", name: "acme", command: "npx", env: { ACME_KEY: "sk-acme-x" } })).rejects.toThrow("There is no vault here to hold the server's values, so nothing was written.");
    expect(readFileSync(join(at.home, ".claude.json"), "utf8")).toBe(before);
  });

  it("makes a config that is not there yet with its folder, readable by the login alone", async () => {
    const at = fixture();
    rmSync(join(at.home, ".gemini"), { recursive: true });
    await serversActs({ here: () => here(at) }).add(HERE, { agent: "gemini", name: "acme", command: "uvx", args: ["acme"] });
    const file = join(at.home, ".gemini/settings.json");
    expect(json(file)).toEqual({ mcpServers: { acme: { command: "uvx", args: ["acme"] } } });
    expect(mode(file)).toBe(0o600);
  });

  it("puts a project's server in the project's own file from a workspace, and asks a workspace for one", async () => {
    const at = fixture();
    const acts = serversActs({ here: () => here(at) });
    expect(await acts.add({ kind: "here", projects: [{ id: "pr_app", name: "app", path: at.project }] }, { agent: "claude", name: "acme", project: true, command: "npx", args: [] })).toEqual({ file: "~/code/app/.mcp.json" });
    expect(Object.keys(json(join(at.project, ".mcp.json")).mcpServers!)).toEqual(["project-db", "acme"]);
    await expect(acts.add(HERE, { agent: "claude", name: "acme2", project: true, command: "npx" })).rejects.toThrow("A project's server is changed from a workspace of that project, or from its computer's page.");
  });

  it("puts a project's server in that project's file on a computer you own, as its login, where the page names the project", async () => {
    const at = fixture();
    const { machine } = road(at, { root: true });
    const on: AgentsOn = { ...box(at, machine), projects: [{ id: "pr_app", name: "app", path: at.project }] };
    expect(await serversActs({}).add(on, { agent: "claude", name: "acme", project: true, command: "npx", args: [] })).toEqual({ file: "~/code/app/.mcp.json" });
    expect(Object.keys(json(join(at.project, ".mcp.json")).mcpServers!)).toEqual(["project-db", "acme"]);
    await expect(serversActs({}).add(box(at, machine), { agent: "claude", name: "acme2", project: true, command: "npx" })).rejects.toThrow("A project's server is changed from a workspace of that project, or from its computer's page.");
  });

  it("never writes over a server of that name, and leaves the file as it was", async () => {
    const at = fixture();
    const file = join(at.home, ".claude.json");
    const before = readFileSync(file, "utf8");
    await expect(serversActs({ here: () => here(at) }).add(HERE, { agent: "claude", name: "airtable", command: "npx" })).rejects.toThrow(serverThereRefusal("airtable", "~/.claude.json"));
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses a name that is empty or holds a control character before a line runs", async () => {
    const at = fixture();
    const { machine, lines } = road(at);
    const acts = serversActs();
    for (const name of ["", "  ", "acme\u0015echo x", "a\nb", "\u009bx"]) {
      await expect(acts.add(box(at, machine), { agent: "claude", name, command: "npx" })).rejects.toThrow(serverNameRefusal);
      await expect(acts.remove(box(at, machine), { agent: "claude", name })).rejects.toThrow(serverNameRefusal);
      await expect(acts.toggle(box(at, machine), { agent: "codex", name, on: false })).rejects.toThrow(serverNameRefusal);
    }
    expect(lines).toEqual([]);
  });

  it("does not write through a config that links out of the home, and does write through one that links inside it", async () => {
    const at = fixture();
    const file = join(at.home, ".claude.json");
    const outside = join(at.root, "elsewhere/claude.json");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, readFileSync(file));
    rmSync(file);
    symlinkSync(outside, file);
    const acts = serversActs({ here: () => here(at) });
    const was = readFileSync(outside, "utf8");
    await expect(acts.add(HERE, { agent: "claude", name: "acme", command: "npx" })).rejects.toThrow(/^~\/\.claude\.json is a link to .*elsewhere\/claude\.json, outside the folder it belongs to, so wsp does not write through it\.$/);
    await expect(acts.remove(HERE, { agent: "claude", name: "airtable" })).rejects.toThrow(/is a link to/);
    expect(readFileSync(outside, "utf8")).toBe(was);

    const dotfiles = join(at.home, "dotfiles/claude.json");
    mkdirSync(dirname(dotfiles), { recursive: true });
    writeFileSync(dotfiles, was, { mode: 0o640 });
    rmSync(file);
    symlinkSync(dotfiles, file);
    await acts.add(HERE, { agent: "claude", name: "acme", command: "npx" });
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(Object.keys(json(dotfiles).mcpServers!)).toContain("acme");
    expect(mode(dotfiles)).toBe(0o640);
  });

  it("does not make a config whose folder links out of the home, nor anything out there", async () => {
    const at = fixture();
    rmSync(join(at.home, ".gemini"), { recursive: true });
    const outside = join(at.root, "elsewhere-gemini");
    mkdirSync(outside);
    symlinkSync(outside, join(at.home, ".gemini"));
    await expect(serversActs({ here: () => here(at) }).add(HERE, { agent: "gemini", name: "acme", command: "npx" })).rejects.toThrow(/^~\/\.gemini is a link to .*elsewhere-gemini, outside the folder it belongs to, so wsp does not write through it\.$/);
    expect(existsSync(join(outside, "settings.json"))).toBe(false);
  });

  it("leaves a file the agent wrote between the read and the write as the agent left it", async () => {
    const at = fixture();
    const file = join(at.home, ".claude.json");
    const theirs = JSON.stringify({ mcpServers: {}, numStartups: 99 });
    const { machine } = road(at, { before: cmd => void (cmd.includes("mv -f") && writeFileSync(file, theirs)) });
    await expect(serversActs().add(box(at, machine), { agent: "claude", name: "acme", command: "npx" })).rejects.toThrow(configChangedRefusal("~/.claude.json"));
    expect(readFileSync(file, "utf8")).toBe(theirs);
  });

  it("a write killed partway leaves the old file whole, and the refusal says it stands as it was", async () => {
    const at = fixture();
    const file = join(at.home, ".claude.json");
    const before = readFileSync(file, "utf8");
    // Every cat that writes a file stops after its first bytes for a while, which is where the write is killed.
    const slow = join(at.root, "slow-bin");
    mkdirSync(slow);
    writeFileSync(join(slow, "cat"), '#!/bin/bash\n[ -p /dev/stdout ] && exec /bin/cat "$@"\n/bin/cat "$@" | { dd bs=1 count=16 2>/dev/null; sleep 2; /bin/cat; }\n');
    chmodSync(join(slow, "cat"), 0o755);
    const halfway = (): boolean => readFileSync(file, "utf8") !== before || readdirSync(at.home).some(n => n.startsWith(".wsp-"));
    const machine = {
      exec: (cmd: string, opts?: { stdin?: Uint8Array }): Promise<ExecResult> =>
        new Promise(resolve => {
          const env = { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home };
          const child = spawn("/bin/bash", ["-c", cmd], { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
          const out: Buffer[] = [];
          child.stdout.on("data", (b: Buffer) => out.push(b));
          child.stdin.on("error", () => undefined);
          const poll = setInterval(() => {
            if (opts?.stdin !== undefined && halfway()) process.kill(-child.pid!, "SIGKILL");
          }, 5);
          child.on("close", (code, signal) => {
            clearInterval(poll);
            resolve({ exitCode: signal === "SIGKILL" ? 137 : (code ?? 1), stdout: Buffer.concat(out).toString("utf8"), stderr: "" });
          });
          child.stdin.end(opts?.stdin === undefined ? undefined : Buffer.from(opts.stdin));
        }),
    };
    const on: AgentsOn = { kind: "box", machine, login: { HOME: at.home, PATH: `${slow}:${at.bin}:/usr/bin:/bin` } };
    await expect(serversActs().add(on, { agent: "claude", name: "acme", command: "npx" })).rejects.toThrow("~/.claude.json stands as it was: the write did not finish (exit 137).");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(mode(file)).toBe(0o600);
  }, 20_000);

  it("writes by a rename over the file from beside it, so no copy is left in the folder or anywhere else, and a file keeps its mode", async () => {
    const at = fixture();
    const file = join(at.home, ".gemini/settings.json");
    chmodSync(file, 0o640);
    const { machine, lines } = road(at);
    await serversActs().add(box(at, machine), { agent: "gemini", name: "acme", command: "npx" });
    expect(Object.keys(json(file).mcpServers!)).toEqual(["fs", "acme"]);
    expect(mode(file)).toBe(0o640);
    expect(readdirSync(dirname(file)).filter(n => n.startsWith(".wsp-"))).toEqual([]);
    expect(lines.at(-1)).not.toContain("$(mktemp)");
  });

  it("refuses a config with a second hard link, which the rename would split from it, and writes nothing", async () => {
    const at = fixture();
    const file = join(at.home, ".claude.json");
    const before = readFileSync(file, "utf8");
    linkSync(file, join(at.root, "twin.json"));
    const { machine } = road(at);
    await expect(serversActs().add(box(at, machine), { agent: "claude", name: "acme", command: "npx" })).rejects.toThrow(configHardLinkRefusal("~/.claude.json"));
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps a jsonc file's comments through an add, a turn off and a remove", async () => {
    const at = fixture();
    const file = join(at.home, ".config/opencode/opencode.jsonc");
    rmSync(join(at.home, ".config/opencode/opencode.json"));
    writeFileSync(file, '{\n  // my model, do not change\n  "model": "x",\n  "mcp": { /* mine */ "ctx": { "type": "remote", "url": "https://ctx.example/mcp", "enabled": true } }\n}\n');
    const acts = serversActs({ here: () => here(at) });
    await acts.add(HERE, { agent: "opencode", name: "acme", command: "npx" });
    await acts.toggle(HERE, { agent: "opencode", name: "ctx", on: false });
    await acts.remove(HERE, { agent: "opencode", name: "acme" });
    const after = readFileSync(file, "utf8");
    expect(after).toContain("// my model, do not change\n");
    expect(after).toContain("/* mine */");
    expect(OPENCODE_JSON.read(after, at.home).map(s => [s.name, s.disabled === true])).toEqual([["ctx", true]]);
  });

  it("refuses a name the agent's format would not read back as that name, before a line runs, and takes one it would", async () => {
    const at = fixture();
    const { machine, lines } = road(at);
    await expect(serversActs().add(box(at, machine), { agent: "codex", name: 'x"] ', command: "npx" })).rejects.toThrow(serverNameFormatRefusal("Codex"));
    expect(lines).toEqual([]);
    const acts = serversActs({ here: () => here(at) });
    for (const name of ["a.b", "my server", "__proto__"]) {
      await acts.add(HERE, { agent: "codex", name, command: "npx" });
      await acts.add(HERE, { agent: "claude", name, command: "npx" });
    }
    expect(CODEX_TOML.read(readFileSync(join(at.home, ".codex/config.toml"), "utf8"), at.home).map(s => s.name)).toEqual(["linear", "old", "a.b", "my server", "__proto__"]);
    expect(Object.keys(json(join(at.home, ".claude.json")).mcpServers!)).toEqual(["airtable", "notion", "wsp", "a.b", "my server", "__proto__"]);
  });

  it("refuses a config that came back cut short rather than writing what was read of it", async () => {
    const at = fixture();
    const file = join(at.home, ".claude.json");
    const before = readFileSync(file, "utf8");
    const { machine } = road(at, { cut: out => (out.startsWith("at\t") ? out.slice(0, -40) : out) });
    await expect(serversActs().add(box(at, machine), { agent: "claude", name: "acme", command: "npx" })).rejects.toThrow("~/.claude.json came back cut short, so it was not changed.");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("on a root box runs every line as the owner of the home, the text riding stdin; a workspace's machine stages it first", async () => {
    const at = fixture();
    const rooted = road(at, { root: true });
    await serversActs().add(box(at, rooted.machine), { agent: "opencode", name: "acme", url: "https://mcp.acme.example/mcp" });
    expect(rooted.lines.slice(1).every(l => l.startsWith("runuser -u 'ada' -- bash -c "))).toBe(true);
    expect(OPENCODE_JSON.read(readFileSync(join(at.home, ".config/opencode/opencode.json"), "utf8"), at.home).map(s => s.name)).toEqual(["ctx", "acme"]);
    const staged = road(at, { bytes: true });
    await serversActs().add({ kind: "machine", machine: staged.machine }, { agent: "claude", name: "staged", command: "npx" });
    expect(Object.keys(json(join(at.home, ".claude.json")).mcpServers!)).toContain("staged");
    expect(staged.lines.some(l => l.includes("/tmp/wsp-land-"))).toBe(true);
  });
});

describe("removing an MCP server", () => {
  it("takes only that one entry out of the scope it was read from, every other server and key as it was", async () => {
    const at = fixture();
    const file = join(at.home, ".claude.json");
    const before = json(file);
    const acts = serversActs({ here: () => here(at) });
    expect(await acts.remove(HERE, { agent: "claude", name: "airtable" })).toEqual({ file: "~/.claude.json" });
    const { airtable: _gone, ...rest } = before.mcpServers!;
    expect(json(file)).toEqual({ ...before, mcpServers: rest });
    await acts.remove(HERE, { agent: "claude", name: "local", scope: "home" });
    expect(json(file).projects).toEqual({ [at.home]: { mcpServers: {} } });
    expect(json(file).mcpServers).toEqual(rest);
    expect(mode(file)).toBe(0o600);
  });

  it("takes a Codex table out with its lines, and a project's server out of the project's file", async () => {
    const at = fixture();
    const acts = serversActs({ here: () => here(at) });
    await acts.remove(HERE, { agent: "codex", name: "linear" });
    expect(readFileSync(join(at.home, ".codex/config.toml"), "utf8")).toBe(`model = "gpt-5"\n\n[mcp_servers.old]\ncommand = "uvx"\nargs = ["old-server"]\nenabled = false\n`);
    await acts.remove({ kind: "here", projects: [{ id: "pr_app", name: "app", path: at.project }] }, { agent: "claude", name: "project-db", scope: "project" });
    expect(json(join(at.project, ".mcp.json"))).toEqual({ mcpServers: {} });
  });

  it("refuses a server the file does not define in that scope, and writes nothing", async () => {
    const at = fixture();
    const file = join(at.home, ".claude.json");
    const before = readFileSync(file, "utf8");
    const acts = serversActs({ here: () => here(at) });
    await expect(acts.remove(HERE, { agent: "claude", name: "nope" })).rejects.toThrow(noSuchServerRefusal("nope", "~/.claude.json"));
    await expect(acts.remove(HERE, { agent: "claude", name: "local" })).rejects.toThrow(noSuchServerRefusal("local", "~/.claude.json"));
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("turning an MCP server off and on", () => {
  it("a Gemini CLI server turned off and removed is gone whole, so a new one of that name is on", async () => {
    const at = fixture();
    const file = join(at.home, ".gemini/settings.json");
    const acts = serversActs({ here: () => here(at) });
    await acts.toggle(HERE, { agent: "gemini", name: "fs", on: false });
    await acts.remove(HERE, { agent: "gemini", name: "fs" });
    await acts.add(HERE, { agent: "gemini", name: "fs", command: "npx" });
    expect(GEMINI_SETTINGS_JSON.read(readFileSync(file, "utf8"), at.home).map(s => [s.name, s.disabled === true])).toEqual([["fs", false]]);
  });

  it("flips the switch the agent reads: Codex's enabled line, OpenCode's enabled field", async () => {
    const at = fixture();
    const acts = serversActs({ here: () => here(at) });
    await acts.toggle(HERE, { agent: "codex", name: "old", on: true });
    expect(CODEX_TOML.read(readFileSync(join(at.home, ".codex/config.toml"), "utf8"), at.home).map(s => [s.name, s.disabled === true])).toEqual([["linear", false], ["old", false]]);
    await acts.toggle(HERE, { agent: "codex", name: "linear", on: false });
    expect(CODEX_TOML.read(readFileSync(join(at.home, ".codex/config.toml"), "utf8"), at.home).map(s => [s.name, s.disabled === true])).toEqual([["linear", true], ["old", false]]);
    await acts.toggle(HERE, { agent: "opencode", name: "ctx", on: true });
    expect(json(join(at.home, ".config/opencode/opencode.json")).mcp).toEqual({ ctx: { type: "remote", url: "https://ctx.example/mcp", enabled: true } });
  });

  it("refuses an agent with no switch per server and a server already that way, writing nothing", async () => {
    const at = fixture();
    const acts = serversActs({ here: () => here(at) });
    const claude = readFileSync(join(at.home, ".claude.json"), "utf8");
    await expect(acts.toggle(HERE, { agent: "claude", name: "airtable", on: false })).rejects.toThrow(noServerSwitchRefusal("Claude Code"));
    expect(readFileSync(join(at.home, ".claude.json"), "utf8")).toBe(claude);
    await expect(acts.toggle(HERE, { agent: "codex", name: "old", on: false })).rejects.toThrow("old is already off.");
  });
});

describe("the server a person typed", () => {
  it("is a command or an address, never both or neither, and every name and value is checked", () => {
    expect(serverTransport({ command: " npx ", args: ["-y"], env: { A_KEY: "v" } })).toEqual({ kind: "stdio", command: "npx", args: ["-y"], env: { A_KEY: "v" } });
    expect(serverTransport({ url: "https://m.example/mcp", headers: { "X-Api-Key": "v" } })).toEqual({ kind: "http", url: "https://m.example/mcp", headers: { "X-Api-Key": "v" } });
    const refused = (ask: Parameters<typeof serverTransport>[0]): string => {
      try {
        serverTransport(ask);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("not refused");
    };
    expect(refused({ command: "npx", url: "https://m.example" })).toBe("A server is a command or an address, not both.");
    expect(refused({})).toBe("A server needs a command to run or an address to reach.");
    expect(refused({ url: "file:///etc/passwd" })).toBe("The address is not one that starts with https:// or http://.");
    expect(refused({ url: "not a url" })).toBe("The address is not one that starts with https:// or http://.");
    expect(refused({ command: "npx", env: { "BAD-NAME": "v" } })).toBe("A variable's name is letters, digits and underscores, not starting with a digit, so nothing was written.");
    expect(refused({ command: "npx", env: { "ACME_KEY=sk-live-SECRET3": "" } })).not.toContain("SECRET3");
    expect(refused({ command: "npx", headers: { A: "v" } })).toBe("Headers go with an address; a command takes variables.");
    expect(refused({ url: "https://m.example", env: { A: "v" } })).toBe("Variables go with a command; an address takes headers.");
    expect(refused({ url: "https://m.example", headers: { "Bad Header": "v" } })).toBe("A header's name is letters, digits and the marks ! # $ % & ' * + - . ^ _ ` | ~, so nothing was written.");
    expect(refused({ url: "https://m.example", headers: { "Authorization: Bearer SECRET4": "" } })).not.toContain("SECRET4");
    expect(refused({ command: "npx", args: ["a\nb"] })).toBe("The command holds a control character, so nothing was written.");
    const injected = refused({ url: "https://m.example", headers: { Authorization: "Bearer sk-secret\r\nX-Evil: 1" } });
    expect(injected).toBe("A header's value holds a control character, so nothing was written.");
    expect(refused({ command: "npx", env: { A: "sk-secret\u0000" } })).toBe("A variable's value holds a control character, so nothing was written.");
  });
});
