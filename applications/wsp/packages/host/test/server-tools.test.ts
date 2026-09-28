// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodeHost, type Host } from "@wsp/collect";
import type { ExecResult, Machine } from "@wsp/engine";
import { serverToolsLateRefusal } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { agentsReader } from "../src/agents-reader.js";
import { noSuchServerRefusal } from "../src/server-tools.js";

const SECRET = "sk-x-fake-secret-value";

// A stdio MCP server as a script: it counts its starts, answers initialize only after a second in which nothing
// else may arrive, refusing a tools/list sent before that answer, and names the length of the variable it was
// handed, never its value.
const SERVER = `#!/bin/bash
echo $$ >> "$HOME/starts"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      if read -r -t 1 early; then echo "tools/list came before initialize was answered" >&2; exit 3; fi
      printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"1"}}}' ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"list_records","description":"List records in a base","inputSchema":{"type":"object","properties":{"base":{"type":"string","description":"The base id"},"limit":{"type":["integer","null"]},"view":{}},"required":["base"]}},{"name":"token_%s"}]}}\\n' "\${#FAKE_TOKEN}" ;;
  esac
done
`;

/** A server that takes its lines and never answers, keeping its pid where the test can look. */
const MUTE = `#!/bin/bash\necho $$ > "$HOME/mute.pid"\nsleep 60 & wait\n`;
const CRASH = `#!/bin/bash\necho $$ >> "$HOME/crash.starts"\necho "airtable: AIRTABLE_API_KEY is not set" >&2\nexit 1\n`;
/** Starts a grandchild in a session of its own, out of the server's process group, then runs as \`server\` or \`mute\`. */
const ESCAPE = `#!/bin/bash
${JSON.stringify(process.execPath)} -e 'const c = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" }); require("fs").appendFileSync(process.env.HOME + "/escaped.pid", c.pid + "\\n"); c.unref()'
exec "$(dirname "$0")/$1"
`;
/** Says eight megabytes of nothing on stdout, then waits out the deadline. */
const FLOOD = `#!/bin/bash\nhead -c 8000000 /dev/zero | tr '\\0' x\nsleep 60 & wait\n`;
/** Claude Code's single-server check as its words read, for a server whose sign-in it holds. */
const CLAUDE = `#!/bin/bash\n[ "$1 $2 $3" = "mcp get linear" ] || exit 9\necho asked >> "$HOME/claude-asks"\nprintf 'linear:\\n  Scope: User config (available in all your projects)\\n  Status: ⚠ Needs authentication\\n'\n`;
/** Answers initialize, then tools/list with a JSON-RPC error whose message carries a key. */
const REFUSES = `#!/bin/bash
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
    *'"method":"tools/list"'*) printf '{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"bad key %s"}}\\n' "$FAKE_TOKEN" ;;
  esac
done
`;
/** grep as it is, keeping every argument list it was handed. */
const GREP = `#!/bin/bash\nprintf '%s\\n' "$*" >> "$HOME/grep-args"\nPATH=/usr/bin:/bin exec grep "$@"\n`;

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) {
    const pids = ["escaped.pid", "family.pids"].flatMap(f => (existsSync(join(r, "home", f)) ? readFileSync(join(r, "home", f), "utf8").trim().split("\n") : []));
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
    rmSync(r, { recursive: true, force: true });
  }
  await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve))));
});

/** An MCP server over http: initialize names a session, tools/list answers as an event stream, and every post without
 * the key header is turned away; `/oauth` turns everything away. */
async function remote(): Promise<{ url: string; posts: string[] }> {
  const posts: string[] = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      posts.push(`${req.url} ${req.headers["mcp-session-id"] ?? "-"} ${body.includes("tools/list") ? "list" : body.includes("initialized") ? "initialized" : "initialize"}`);
      if (req.url === "/oauth" || req.headers["x-key"] !== SECRET) return void res.writeHead(401).end();
      if (body.includes('"method":"initialize"')) return void res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      if (body.includes("notifications/initialized")) return void res.writeHead(202).end();
      res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search", description: "Search the workspace" }] } })}\n\n`);
    });
  });
  servers.push(srv);
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, posts };
}

interface Fixture {
  root: string;
  home: string;
  bin: string;
  config: (servers: Record<string, unknown>) => void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "wsp-tools-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(join(root, "tmp"));
  for (const [name, text] of Object.entries({ server: SERVER, mute: MUTE, crash: CRASH, claude: CLAUDE, escape: ESCAPE, flood: FLOOD, refuses: REFUSES })) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  return { root, home, bin, config: servers => writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers })) };
}

/** This computer's own Host over the fixture's home, PATH and temp folder. */
function here(f: Fixture): Host {
  const live = nodeHost();
  return { ...live, home: f.home, exec: { ...live.exec, run: (cmd, args, o) => live.exec.run(cmd, args, { ...o, env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, TMPDIR: join(f.root, "tmp"), ...o?.env } }) } };
}

/** A fork, or a workspace on a box: every line runs in bash with the fixture's home, its stdin is never handed to the
 * line, and bytes land by the backend's own road. The lines, the paths landed and the modes the landed file and its
 * folder had when the server's line ran are kept. */
function fork(f: Fixture): { machine: Pick<Machine, "exec" | "id" | "putBytes" | "uploadUrl">; lines: string[]; landed: string[]; modes: string[] } {
  const lines: string[] = [];
  const landed: string[] = [];
  const modes: string[] = [];
  const machine = {
    id: "m_fork",
    uploadUrl: () => Promise.reject(new Error("this backend mints no signed urls")),
    putBytes: (path: string, bytes: Uint8Array): Promise<void> => {
      landed.push(path);
      writeFileSync(path, bytes);
      return Promise.resolve();
    },
    exec: (cmd: string): Promise<ExecResult> => {
      lines.push(cmd);
      for (const path of landed) if (cmd.includes(join(f.bin, "server")) && existsSync(path)) modes.push(`${(statSync(dirname(path)).mode & 0o777).toString(8)} ${(statSync(path).mode & 0o777).toString(8)}`);
      return new Promise(resolve => {
        const child = spawn("/bin/bash", ["-c", cmd], { env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", c => (stdout += c));
        child.stderr.on("data", c => (stderr += c));
        child.on("close", code => resolve({ exitCode: code ?? 1, stdout, stderr }));
        child.stdin.end();
      });
    },
  };
  return { machine, lines, landed, modes };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** The pid a server wrote to that file, waited for up to five seconds by default, and never past its fixture. */
async function pidIn(path: string, tries = 50): Promise<number> {
  for (let i = 0; i < tries && existsSync(dirname(path)); i++) {
    const pid = existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : 0;
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`no pid was written to ${path}`);
}
const escaped = (f: Fixture): number[] => readFileSync(join(f.home, "escaped.pid"), "utf8").trim().split("\n").map(Number);

/** A computer you joined whose daemon runs as root: every line through the root road's probe answer, then bash with
 * the fixture's home, the frame's stdin handed to it; the lines are kept. */
function box(f: Fixture): { machine: Pick<Machine, "exec">; lines: string[] } {
  const lines: string[] = [];
  writeFileSync(join(f.bin, "runuser"), `#!/bin/bash\n[ "$1" = -u ] && [ "$2" = ada ] && [ "$3" = -- ] || exit 9\nshift 3\nexec "$@"\n`);
  chmodSync(join(f.bin, "runuser"), 0o755);
  const machine = {
    exec: (cmd: string, o?: { stdin?: Uint8Array }): Promise<ExecResult> => {
      lines.push(cmd);
      if (cmd.startsWith("uname -s;")) return Promise.resolve({ exitCode: 0, stdout: ["Linux", "0", "root", "ada", "1", f.home, `${f.bin}:/usr/bin:/bin`, ""].join("\n"), stderr: "" });
      return new Promise(resolve => {
        const child = spawn("/bin/bash", ["-c", cmd], { env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", c => (stdout += c));
        child.stderr.on("data", c => (stderr += c));
        child.on("close", code => resolve({ exitCode: code ?? 1, stdout, stderr }));
        child.stdin.end(o?.stdin ?? Buffer.alloc(0));
      });
    },
  };
  return { machine, lines };
}

const starts = (f: Fixture): number => (existsSync(join(f.home, "starts")) ? readFileSync(join(f.home, "starts"), "utf8").trim().split("\n").length : 0);

/** A command server with a family: it starts two children that outlive nothing on their own, keeps every pid it and
 * they have, then answers as \`server\` does or, handed \`hang\`, never answers. */
const FAMILY = `#!/bin/bash
sleep 300 &
echo $! >> "$HOME/family.pids"
sleep 301 &
echo $! >> "$HOME/family.pids"
echo $$ >> "$HOME/family.pids"
[ "$1" = hang ] && { sleep 300 & wait; }
exec "$(dirname "$0")/server"
`;

/** Whether a process is running, a zombie not yet reaped counting as gone. */
const running = (pid: number): boolean => {
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).includes("Z");
  } catch {
    return false;
  }
};

/** The deadline's timer is the script's sleep: this one runs until the test writes \`up\`, which the returned call does
 * and waits for the answer. */
function heldTimer(f: Fixture): <T>(asked: Promise<T>) => Promise<T> {
  writeFileSync(join(f.bin, "sleep"), `#!/bin/bash\n[ "$1" = 30.0 ] || exec /bin/sleep "$@"\necho $$ > "$HOME/timer.pid"\nuntil [ -e "$HOME/up" ] || [ ! -d "$HOME" ]; do /bin/sleep 0.05; done\n`);
  chmodSync(join(f.bin, "sleep"), 0o755);
  return async asked => {
    await pidIn(join(f.home, "timer.pid"), Infinity);
    writeFileSync(join(f.home, "up"), "");
    return asked;
  };
}

/** Every process of a family still running. */
const leftOver = (f: Fixture): number[] => (existsSync(join(f.home, "family.pids")) ? readFileSync(join(f.home, "family.pids"), "utf8").trim().split("\n").map(Number) : []).filter(alive);

describe("one MCP server's tools, on the person's ask", () => {
  it("starts a command server once with its own variables, sends tools/list only after initialize is answered, and keeps the answer three minutes", async () => {
    const f = fixture();
    f.config({ airtable: { command: join(f.bin, "server"), args: ["--base", "app1"], env: { FAKE_TOKEN: SECRET } } });
    let now = Date.parse("2026-09-24T12:00:00Z");
    const reader = agentsReader({ vault: () => ({}), here: () => here(f), now: () => now });
    const ask = { key: "here", agent: "claude", name: "airtable" };
    const first = await reader.tools({ kind: "here" }, ask);
    const params = [{ name: "base", type: "string", required: true, description: "The base id" }, { name: "limit", type: "integer or null", required: false }, { name: "view", required: false }];
    expect(first).toEqual({ auth: "connected", tools: [{ name: "list_records", description: "List records in a base", params }, { name: `token_${SECRET.length}` }], readAt: "2026-09-24T12:00:00.000Z" });
    expect(starts(f)).toBe(1);
    now += 2 * 60_000;
    expect(await reader.tools({ kind: "here" }, ask)).toEqual(first);
    expect(starts(f)).toBe(1);
    expect((await reader.tools({ kind: "here" }, { ...ask, refresh: true })).readAt).toBe("2026-09-24T12:02:00.000Z");
    expect(starts(f)).toBe(2);
    // An edited entry is another definition and is started again.
    f.config({ airtable: { command: join(f.bin, "server"), args: ["--base", "app2"], env: { FAKE_TOKEN: SECRET } } });
    await reader.tools({ kind: "here" }, ask);
    expect(starts(f)).toBe(3);
    now += 3 * 60_000;
    await reader.tools({ kind: "here" }, ask);
    expect(starts(f)).toBe(4);
  }, 30_000);

  it("connects once to a server every agent's file names, however many ask at once, and again once a sign-in there forgets it", async () => {
    const f = fixture();
    f.config({ airtable: { command: join(f.bin, "server"), args: [], env: { FAKE_TOKEN: SECRET } } });
    mkdirSync(join(f.home, ".codex"));
    writeFileSync(join(f.home, ".codex", "config.toml"), `[mcp_servers.airtable]\ncommand = "${join(f.bin, "server")}"\nargs = []\n\n[mcp_servers.airtable.env]\nFAKE_TOKEN = "${SECRET}"\n`);
    const reader = agentsReader({ vault: () => ({}), here: () => here(f) });
    const answers = await Promise.all(["claude", "codex", "claude"].map(agent => reader.tools({ kind: "here" }, { key: "here", agent, name: "airtable" })));
    expect(answers.map(a => a.auth)).toEqual(["connected", "connected", "connected"]);
    expect(starts(f)).toBe(1);
    await reader.tools({ kind: "here" }, { key: "there", agent: "claude", name: "airtable" });
    expect(starts(f), "another target keeps its own answer").toBe(2);
    reader.forget("here");
    await reader.tools({ kind: "here" }, { key: "here", agent: "codex", name: "airtable" });
    expect(starts(f)).toBe(3);
  }, 30_000);

  it("leaves no process a check started running, once its tools/list answered or its deadline passed", async () => {
    const f = fixture();
    writeFileSync(join(f.bin, "family"), FAMILY);
    chmodSync(join(f.bin, "family"), 0o755);
    f.config({ answers: { command: join(f.bin, "family"), args: [], env: { FAKE_TOKEN: SECRET } }, hangs: { command: join(f.bin, "family"), args: ["hang"] } });
    // The answering one keeps the whole deadline, since a server that waits a second before its answer can pass two
    // on a busy machine; the hanging one is cut at two.
    const reader = agentsReader({ vault: () => ({}), here: () => here(f), toolsMs: 2_000 });
    expect((await agentsReader({ vault: () => ({}), here: () => here(f) }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "answers" })).auth).toBe("connected");
    const answered = readFileSync(join(f.home, "family.pids"), "utf8").trim().split("\n");
    expect(answered, "the server and its two children").toHaveLength(3);
    expect(leftOver(f), "left running after an answer").toEqual([]);
    expect(await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "hangs" })).toMatchObject({ auth: "failed", refused: serverToolsLateRefusal(2_000) });
    expect(readFileSync(join(f.home, "family.pids"), "utf8").trim().split("\n")).toHaveLength(6);
    expect(leftOver(f), "left running after the deadline").toEqual([]);
  }, 30_000);

  it("starts at most four servers at once", async () => {
    const f = fixture();
    const names = ["s1", "s2", "s3", "s4", "s5", "s6"];
    writeFileSync(join(f.bin, "counted"), `#!/bin/bash\ntouch "$HOME/in.$$"; ls "$HOME" | grep -c '^in\\.' >> "$HOME/peak"; sleep 0.3; rm -f "$HOME/in.$$"\nexec "$(dirname "$0")/server"\n`);
    chmodSync(join(f.bin, "counted"), 0o755);
    f.config(Object.fromEntries(names.map(n => [n, { command: join(f.bin, "counted"), args: [n], env: { FAKE_TOKEN: SECRET } }])));
    const reader = agentsReader({ vault: () => ({}), here: () => here(f) });
    const answers = await Promise.all(names.map(name => reader.tools({ kind: "here" }, { key: "here", agent: "claude", name })));
    expect(answers.map(a => a.auth)).toEqual(names.map(() => "connected"));
    const peaks = readFileSync(join(f.home, "peak"), "utf8").trim().split("\n").map(Number);
    expect(peaks).toHaveLength(6);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(4);
  }, 30_000);

  it("stops a server that has not answered when the time is up, with its process group", async () => {
    const f = fixture();
    const timeUp = heldTimer(f);
    f.config({ mute: { command: join(f.bin, "mute"), args: [] } });
    const reader = agentsReader({ vault: () => ({}), here: () => here(f), toolsMs: 30_000 });
    let settled = false;
    const asked = reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "mute" }).finally(() => (settled = true));
    const pid = await pidIn(join(f.home, "mute.pid"), Infinity);
    await Promise.race([pidIn(join(f.home, "timer.pid"), Infinity), asked]);
    expect(settled, "the server was stopped before its time was up").toBe(false);
    expect(running(pid), "the server was stopped before its time was up").toBe(true);
    const late = await timeUp(asked);
    expect(late).toMatchObject({ auth: "failed", refused: serverToolsLateRefusal(30_000) });
    expect(late.tools).toBeUndefined();
    expect(running(pid), "the server outlived its deadline").toBe(false);
  }, 20_000);

  it("stops the server's whole process group when the host's own bound on the run ends it first, and says its time ran out", async () => {
    const f = fixture();
    writeFileSync(join(f.bin, "family"), FAMILY);
    chmodSync(join(f.bin, "family"), 0o755);
    heldTimer(f);
    f.config({ hangs: { command: join(f.bin, "family"), args: ["hang"] } });
    let now = Date.parse("2026-09-24T12:00:00Z");
    let bound: (() => void) | undefined;
    // The host's bound on a run, fired when the test says: the clock moves past it and the run's group is sent TERM, as the live host does.
    const host: Host = {
      ...here(f),
      exec: {
        ...here(f).exec,
        run: (cmd, args, o) =>
          new Promise(resolve => {
            const child = spawn(cmd, [...args], { stdio: ["ignore", "ignore", "ignore"], detached: true, env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, TMPDIR: join(f.root, "tmp"), ...o?.env } });
            bound = () => {
              now += o?.timeoutMs ?? 0;
              process.kill(-child.pid!, "SIGTERM");
            };
            child.on("exit", () => resolve(undefined));
          }),
      },
    };
    const reader = agentsReader({ vault: () => ({}), here: () => host, toolsMs: 30_000, now: () => now });
    const asked = reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "hangs" });
    await pidIn(join(f.home, "timer.pid"), Infinity);
    while (existsSync(f.home) && leftOver(f).length < 3) await new Promise(resolve => setTimeout(resolve, 50));
    bound!();
    expect(await asked).toMatchObject({ auth: "failed", refused: serverToolsLateRefusal(30_000) });
    expect(readFileSync(join(f.home, "family.pids"), "utf8").trim().split("\n").map(Number).filter(running), "left running after the host's bound").toEqual([]);
  }, 20_000);

  it("says a server exited before it answered, with what it said on stderr in the host's log alone, keeps that until a refresh, and refuses a name no config has", async () => {
    const f = fixture();
    f.config({ crash: { command: join(f.bin, "crash"), args: [] } });
    const logged: string[] = [];
    const reader = agentsReader({ vault: () => ({}), here: () => here(f), log: line => logged.push(line) });
    const starts = (): number => readFileSync(join(f.home, "crash.starts"), "utf8").trim().split("\n").length;
    // What a server said on stderr can carry its own key: it goes to the host's log, never onto the page.
    const crashed = await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "crash" });
    expect(crashed).toMatchObject({ auth: "failed", refused: "it exited with 1 before it answered" });
    expect(JSON.stringify(crashed)).not.toContain("AIRTABLE_API_KEY");
    expect(logged.join("\n")).toContain("airtable: AIRTABLE_API_KEY is not set");
    expect(await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "crash" }), "a failed answer is the state until a refresh").toEqual(crashed);
    expect(starts()).toBe(1);
    await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "crash", refresh: true });
    expect(starts()).toBe(2);
    await expect(reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "nobody" })).rejects.toThrow(noSuchServerRefusal("nobody", "Claude Code"));
  }, 20_000);

  it("asks an address over curl with its headers from a private file, and a server behind a sign-in the harness holds for the harness's word alone", async () => {
    const f = fixture();
    const { url, posts } = await remote();
    f.config({ notion: { type: "http", url: `${url}/mcp`, headers: { "X-Key": SECRET } }, linear: { type: "http", url: `${url}/oauth` } });
    const reader = agentsReader({ vault: () => ({}), here: () => here(f) });
    expect(await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "notion" })).toMatchObject({ auth: "connected", tools: [{ name: "search", description: "Search the workspace" }] });
    expect(posts.slice(0, 3)).toEqual(["/mcp - initialize", "/mcp s-1 initialized", "/mcp s-1 list"]);
    expect(await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "linear" })).toMatchObject({ auth: "needs-sign-in", holder: "claude" });
    await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "linear", refresh: true });
    expect(readFileSync(join(f.home, "claude-asks"), "utf8").trim().split("\n"), "the harness is asked once per ten minutes, a refresh too").toHaveLength(1);
    mkdirSync(join(f.home, ".codex"));
    writeFileSync(join(f.home, ".codex", "config.toml"), `[mcp_servers.linear]\nurl = "${url}/oauth"\n`);
    writeFileSync(join(f.bin, "codex"), `#!/bin/bash\necho asked >> "$HOME/codex-asks"\n`);
    chmodSync(join(f.bin, "codex"), 0o755);
    expect(await reader.tools({ kind: "here" }, { key: "here", agent: "codex", name: "linear" })).toEqual({ auth: "unknown", holder: "codex", readAt: expect.any(String) });
    expect(existsSync(join(f.home, "codex-asks")), "Codex was asked for its servers").toBe(false);
  });

  it("says curl's last words for an address that did not answer, with any query string in a URL cut off", async () => {
    const f = fixture();
    writeFileSync(join(f.bin, "curl"), `#!/bin/bash\necho "curl: (7) Failed to connect to https://mcp.example.test/sse?token=${SECRET}&x=1 port 443" >&2\nexit 7\n`);
    chmodSync(join(f.bin, "curl"), 0o755);
    f.config({ notion: { type: "http", url: `https://mcp.example.test/sse?token=${SECRET}` } });
    const answer = await agentsReader({ vault: () => ({}), here: () => here(f) }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "notion" });
    expect(answer).toMatchObject({ auth: "failed", refused: "curl: (7) Failed to connect to https://mcp.example.test/sse port 443" });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it("cuts a user and password out of a URL in curl's last words", async () => {
    const f = fixture();
    writeFileSync(join(f.bin, "curl"), `#!/bin/bash\necho "curl: (7) Failed to connect to https://ada:${SECRET}@mcp.example.test/sse port 443" >&2\nexit 7\n`);
    chmodSync(join(f.bin, "curl"), 0o755);
    f.config({ notion: { type: "http", url: `https://ada:${SECRET}@mcp.example.test/sse` } });
    const answer = await agentsReader({ vault: () => ({}), here: () => here(f) }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "notion" });
    expect(answer).toMatchObject({ auth: "failed", refused: "curl: (7) Failed to connect to https://mcp.example.test/sse port 443" });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it("on a computer whose daemon runs as root, runs as the home's owner and hands the variables over stdin, never on a line", async () => {
    const f = fixture();
    const { url } = await remote();
    f.config({ airtable: { command: join(f.bin, "server"), args: [], env: { FAKE_TOKEN: SECRET } }, notion: { type: "http", url: `${url}/mcp`, headers: { "X-Key": SECRET } } });
    const { machine, lines } = box(f);
    const reader = agentsReader({ vault: () => ({}) });
    const on = { kind: "box" as const, machine, login: { HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin` } };
    expect(await reader.tools(on, { key: "p_srv", agent: "claude", name: "airtable" })).toMatchObject({ auth: "connected", tools: [{ name: "list_records" }, { name: `token_${SECRET.length}` }] });
    expect(await reader.tools(on, { key: "p_srv", agent: "claude", name: "notion" })).toMatchObject({ auth: "connected", tools: [{ name: "search" }] });
    for (const line of lines.filter(l => !l.startsWith("uname -s;"))) {
      expect(line).toMatch(/^runuser -u 'ada' -- /);
      expect(line).not.toContain(SECRET);
    }
  }, 20_000);
  it("on a fork or a workspace on a box, hands the variables over in a private file the line reads as data and removes", async () => {
    const f = fixture();
    f.config({ airtable: { command: join(f.bin, "server"), args: [], env: { FAKE_TOKEN: SECRET } } });
    const { machine, lines, landed, modes } = fork(f);
    const reader = agentsReader({ vault: () => ({}) });
    expect(await reader.tools({ kind: "machine", machine }, { key: "w_1", agent: "claude", name: "airtable" })).toMatchObject({ auth: "connected", tools: [{ name: "list_records" }, { name: `token_${SECRET.length}` }] });
    expect(landed).toHaveLength(1);
    expect(modes).toEqual(["700 600"]);
    expect(existsSync(dirname(landed[0]!)), "the variables' folder outlived the run").toBe(false);
    for (const line of lines) expect(line).not.toContain(SECRET);
  }, 20_000);

  it("refuses a variable whose name is not a shell name before anything runs, on every road", async () => {
    const f = fixture();
    const hostile = `A=1; touch "$HOME/pwned"; B`;
    f.config({ airtable: { command: join(f.bin, "server"), args: [], env: { [hostile]: "x", FAKE_TOKEN: SECRET } } });
    const { machine, lines, landed } = fork(f);
    const reader = agentsReader({ vault: () => ({}), here: () => here(f) });
    for (const on of [{ kind: "machine" as const, machine }, { kind: "here" as const }]) {
      const answer = await reader.tools(on, { key: on.kind, agent: "claude", name: "airtable" });
      expect(answer).toMatchObject({ auth: "failed", refused: `its variable ${JSON.stringify(hostile)} is not a name a shell takes, so it was not started` });
    }
    expect(starts(f)).toBe(0);
    expect(existsSync(join(f.home, "pwned"))).toBe(false);
    expect(landed).toEqual([]);
    for (const line of lines) expect(line).not.toContain(join(f.bin, "server"));
  }, 20_000);

  it("stops a child that left the server's process group, when the server answered and when the time ran out", async () => {
    const f = fixture();
    f.config({ answers: { command: join(f.bin, "escape"), args: ["server"] }, silent: { command: join(f.bin, "escape"), args: ["mute"] } });
    expect(await agentsReader({ vault: () => ({}), here: () => here(f) }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "answers" })).toMatchObject({ auth: "connected" });
    const late = agentsReader({ vault: () => ({}), here: () => here(f), toolsMs: 2_000 });
    expect(await late.tools({ kind: "here" }, { key: "here", agent: "claude", name: "silent" })).toMatchObject({ refused: serverToolsLateRefusal(2_000) });
    const pids = escaped(f);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(alive(pid), `the escaped child ${pid} outlived the run`).toBe(false);
  }, 20_000);

  it("keeps what a server says on stdout under a cap on the target while it runs", async () => {
    const f = fixture();
    f.config({ flood: { command: join(f.bin, "flood"), args: [] } });
    const reader = agentsReader({ vault: () => ({}), here: () => here(f), toolsMs: 2_000 });
    let most = 0;
    const tmp = join(f.root, "tmp");
    const watch = setInterval(() => {
      for (const d of readdirSync(tmp)) {
        try {
          most = Math.max(most, statSync(join(tmp, d, "out")).size);
        } catch {}
      }
    }, 20);
    try {
      await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "flood" });
    } finally {
      clearInterval(watch);
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(4 * 1024 * 1024);
  }, 20_000);

  it("keeps what an address answers under a cap on the target while it is read", async () => {
    const f = fixture();
    const srv = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = Buffer.alloc(64 * 1024, "x");
        let sent = 0;
        const more = (): void => {
          if (res.destroyed) return;
          if (sent >= 8 * 1024 * 1024) return void res.end();
          sent += chunk.length;
          res.write(chunk);
          setTimeout(more, 5);
        };
        res.on("error", () => undefined);
        more();
      });
    });
    servers.push(srv);
    await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
    f.config({ flood: { type: "http", url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp` } });
    const tmp = join(f.root, "tmp");
    let most = 0;
    const sizes = (dir: string): void => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        try {
          if (d.isDirectory()) sizes(join(dir, d.name));
          else most = Math.max(most, statSync(join(dir, d.name)).size);
        } catch {}
      }
    };
    const watch = setInterval(() => sizes(tmp), 10);
    let answer;
    try {
      answer = await agentsReader({ vault: () => ({}), here: () => here(f), toolsMs: 5_000 }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "flood" });
    } finally {
      clearInterval(watch);
    }
    expect(answer).toMatchObject({ auth: "failed", refused: "its tools answer is over 1 MB and was not read" });
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(1024 * 1024 + 1);
  }, 20_000);

  it("names a server's error by its code alone, and its message goes to the host's log", async () => {
    const f = fixture();
    f.config({ refuses: { command: join(f.bin, "refuses"), args: [], env: { FAKE_TOKEN: SECRET } } });
    const logged: string[] = [];
    const answer = await agentsReader({ vault: () => ({}), here: () => here(f), log: line => logged.push(line) }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "refuses" });
    expect(answer).toMatchObject({ auth: "failed", refused: "it answered tools/list with error -32001" });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(logged.join("\n")).toContain(`bad key ${SECRET}`);
  }, 20_000);

  it("strips control characters from every tool's name, description and parameters, keeping a description's lines", async () => {
    const f = fixture();
    const ESC = String.fromCharCode(27);
    const tools = [{ name: `pay${ESC}[31m_out`, description: `Sends money.${ESC}]0;owned${String.fromCharCode(7)}\nSecond line.`, inputSchema: { type: "object", properties: { [`to${ESC}[2J`]: { type: "string", description: `who${ESC}[0m` } } } }];
    writeFileSync(join(f.bin, "hostile"), `#!/bin/bash\nwhile IFS= read -r line; do case "$line" in *'"method":"initialize"'*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;; *'"method":"tools/list"'*) cat "$HOME/tools.json" ;; esac; done\n`);
    chmodSync(join(f.bin, "hostile"), 0o755);
    writeFileSync(join(f.home, "tools.json"), `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools } })}\n`);
    f.config({ hostile: { command: join(f.bin, "hostile"), args: [] } });
    const answer = await agentsReader({ vault: () => ({}), here: () => here(f) }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "hostile" });
    expect(answer.tools).toEqual([{ name: "pay[31m_out", description: "Sends money.]0;owned\nSecond line.", params: [{ name: "to[2J", type: "string", required: false, description: "who[0m" }] }]);
  }, 20_000);

  it("runs a command server on this computer with the login shell's environment under the config's own", async () => {
    const f = fixture();
    f.config({ fromrc: { command: join(f.bin, "server"), args: [] }, own: { command: join(f.bin, "server"), args: [], env: { FAKE_TOKEN: "abc" } } });
    const reader = agentsReader({ vault: () => ({}), here: () => here(f), loginEnv: async () => ({ FAKE_TOKEN: "exported-in-zshrc" }) });
    const names = async (name: string): Promise<string[]> => ((await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name })).tools ?? []).map(t => t.name);
    expect(await names("fromrc")).toContain(`token_${"exported-in-zshrc".length}`);
    expect(await names("own")).toContain("token_3");
  }, 20_000);

  it("keeps a newline in a header value inside that header's line of curl's config, so it names one address alone", async () => {
    const f = fixture();
    const { url } = await remote();
    // curl as it is, keeping every config it was handed.
    writeFileSync(join(f.bin, "curl"), `#!/bin/bash\nprev=; for a; do [ "$prev" = -K ] && cat "$a" >> "$HOME/curl.k"; prev=$a; done\nexec /usr/bin/curl "$@"\n`);
    chmodSync(join(f.bin, "curl"), 0o755);
    f.config({ split: { type: "http", url: `${url}/mcp`, headers: { "X-Key": `${SECRET}\r\nurl = ${url}/stolen#` } } });
    await agentsReader({ vault: () => ({}), here: () => here(f) }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "split" });
    const lines = readFileSync(join(f.home, "curl.k"), "utf8").split("\n").filter(l => l !== "");
    expect(new Set(lines)).toEqual(new Set([`url = "${url}/mcp"`, `header = "X-Key: ${SECRET}\\r\\nurl = ${url}/stolen#"`]));
  });

  it("hands the run's marker to no command's argument list", async () => {
    const f = fixture();
    writeFileSync(join(f.bin, "grep"), GREP);
    chmodSync(join(f.bin, "grep"), 0o755);
    f.config({ silent: { command: join(f.bin, "escape"), args: ["mute"] } });
    expect(await agentsReader({ vault: () => ({}), here: () => here(f), toolsMs: 1_000 }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "silent" })).toMatchObject({ refused: serverToolsLateRefusal(1_000) });
    expect(existsSync(join(f.home, "grep-args"))).toBe(true);
    expect(readFileSync(join(f.home, "grep-args"), "utf8")).not.toContain("WSP_TOOLS_RUN=");
  }, 20_000);
});

/** An MCP server that answers a plain GET the way a server offering no stream does, takes initialize, and asks for an
 * OAuth sign-in only when its tools are listed: the answer a GET alone reads as needing none. */
async function signInOnList(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const method = req.method === "GET" ? "GET" : body.includes("tools/list") ? "list" : body.includes("notifications/initialized") ? "initialized" : "initialize";
      seen.push(method);
      if (method === "GET") return void res.writeHead(405).end();
      if (method === "initialize") return void res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      if (method === "initialized") return void res.writeHead(202).end();
      res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' }).end();
    });
  });
  servers.push(srv);
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`, seen };
}

/** How many times the stub harness was asked about a server. */
const harnessAsks = (f: Fixture): number => (existsSync(join(f.home, "claude-asks")) ? readFileSync(join(f.home, "claude-asks"), "utf8").trim().split("\n").length : 0);

/** A stub claude whose `mcp get` says Connected for a server named in the home's `signed` file and Needs
 * authentication for any other, keeping each ask. */
function harness(f: Fixture, extra = ""): void {
  writeFileSync(
    join(f.bin, "claude"),
    `#!/bin/bash\n[ "$1 $2" = "mcp get" ] || exit 9\necho "$3" >> "$HOME/claude-asks"\n${extra}\nif grep -qxF "$3" "$HOME/signed" 2>/dev/null; then echo "  Status: ✓ Connected"; else echo "  Status: ! Needs authentication"; fi\n`,
  );
  chmodSync(join(f.bin, "claude"), 0o755);
}

describe("a server's state, off its tools connect alone", () => {
  it("reads a server whose tools call asks for a sign-in as needing one, however it answers a plain GET, and the read claims nothing", async () => {
    const f = fixture();
    harness(f);
    const { url, seen } = await signInOnList();
    f.config({ zomato: { type: "http", url } });
    const reader = agentsReader({ vault: () => ({}), here: () => here(f) });
    const read = await reader.read({ kind: "here" });
    expect(read.servers.find(s => s.name === "zomato")?.auth).toBe("unknown");
    expect(seen, "reading the report asked the server nothing").toEqual([]);
    expect(await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "zomato" })).toEqual({ auth: "needs-sign-in", holder: "claude", readAt: expect.any(String) });
    expect(seen).toEqual(["initialize", "initialized", "list"]);
    writeFileSync(join(f.home, "signed"), "zomato\n");
    reader.forget("here");
    expect(await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "zomato" })).toMatchObject({ auth: "signed-in", holder: "claude" });
  });

  it("asks the harness once per server per sign-in or per ten minutes, however often the server is asked", async () => {
    const f = fixture();
    harness(f);
    const { url } = await remote();
    f.config({ linear: { type: "http", url: `${url}/oauth` } });
    let now = 1_000_000;
    const reader = agentsReader({ vault: () => ({}), here: () => here(f), now: () => now });
    const ask = { key: "a", agent: "claude", name: "linear" };
    await Promise.all([reader.tools({ kind: "here" }, ask), reader.tools({ kind: "here" }, ask)]);
    expect(harnessAsks(f)).toBe(1);
    now += 4 * 60_000;
    await reader.tools({ kind: "here" }, ask);
    expect(harnessAsks(f)).toBe(1);
    now += 6 * 60_000;
    await reader.tools({ kind: "here" }, ask);
    expect(harnessAsks(f)).toBe(2);
    reader.forget("a");
    await reader.tools({ kind: "here" }, ask);
    expect(harnessAsks(f)).toBe(3);
  });

  it("runs at most two harness asks at once", async () => {
    const f = fixture();
    harness(f, `touch "$HOME/in.$$"; ls "$HOME" | grep -c '^in\\.' >> "$HOME/peak"; sleep 0.3; rm -f "$HOME/in.$$"`);
    const { url } = await remote();
    const names = ["a1", "a2", "a3", "a4", "a5"];
    f.config(Object.fromEntries(names.map(n => [n, { type: "http", url: `${url}/oauth`, headers: { "X-Name": n } }])));
    const reader = agentsReader({ vault: () => ({}), here: () => here(f) });
    const answers = await Promise.all(names.map(name => reader.tools({ kind: "here" }, { key: "k", agent: "claude", name })));
    expect(answers.map(a => a.auth)).toEqual(names.map(() => "needs-sign-in"));
    const peaks = readFileSync(join(f.home, "peak"), "utf8").trim().split("\n").map(Number);
    expect(peaks).toHaveLength(5);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(2);
  });

  it("gives the harness five seconds to answer, then keeps the server's own needs sign-in", async () => {
    const f = fixture();
    harness(f, "sleep 8");
    const { url } = await remote();
    f.config({ slow: { type: "http", url: `${url}/oauth` } });
    const started = Date.now();
    const answer = await agentsReader({ vault: () => ({}), here: () => here(f) }).tools({ kind: "here" }, { key: "k", agent: "claude", name: "slow" });
    expect(Date.now() - started).toBeLessThan(7_000);
    expect(answer.auth).toBe("needs-sign-in");
  }, 15_000);

  it("asks no harness for a name set up in two scopes, since the harness picks which one it asks", async () => {
    const f = fixture();
    harness(f);
    const { url } = await remote();
    writeFileSync(join(f.home, ".claude.json"), JSON.stringify({ mcpServers: { twice: { type: "http", url: `${url}/oauth` }, once: { type: "http", url: `${url}/oauth` } }, projects: { [f.home]: { mcpServers: { twice: { command: "touch", args: ["started"] } } } } }));
    writeFileSync(join(f.home, ".mcp.json"), JSON.stringify({ mcpServers: { once: { command: "touch", args: ["started-too"] } } }));
    const reader = agentsReader({ vault: () => ({}), here: () => here(f) });
    for (const name of ["twice", "once"]) expect(await reader.tools({ kind: "here" }, { key: "k", agent: "claude", name }), name).toMatchObject({ auth: "unknown", holder: "claude" });
    expect(harnessAsks(f)).toBe(0);
    expect(existsSync(join(f.home, "started")) || existsSync(join(f.home, "started-too"))).toBe(false);
  });
});
