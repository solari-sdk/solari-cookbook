// SPDX-License-Identifier: AGPL-3.0-only
// What the verbs and the MCP server are tested against: a captured CliIO, a
// scripted harness that answers every prompt, one whose turn never ends, and
// the guest side of the exec stream over the stub backend.
import { randomUUID } from "node:crypto";
import { PERMISSION_ALLOW, PERMISSION_DENY } from "@wsp/protocol";
import type { AdapterEvent, Caller, PermissionAsk, PermissionOutcome, ProjectView, SessionRenameWrite, TurnResult } from "@wsp/protocol";
import { tarOf, type ExecResult } from "@wsp/engine";
import type { CreatedWorkspace, HarnessAdapterFactory, HarnessStartOptions, ProjectBundler, Runtime } from "@wsp/runtime";
import { DAEMON_VERSION } from "@wsp/protocol";
import type { CliIO, LocalDaemonStart } from "../src/cli.js";
import type { StubBackend } from "./stub-backend.js";
import { copyingFake, createOn as createOnRuntime, projectOn as projectOnRuntime, type CreateOn } from "../../runtime/test/stub-backend.js";

export { copyingFake };

/** The daemon beside this host as a test wires it: never spawned, answering the version this wsp needs, so the copy
 * road's version read passes and no binary is looked for. A test that wants the real one stages it and wires none. */
export const fakeDaemonStart: LocalDaemonStart = async () =>
  ({ version: DAEMON_VERSION, road: { url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }, sysSamples: async () => () => {}, close: async () => {} }) as unknown as Awaited<ReturnType<LocalDaemonStart>>;

export const PAGE = `<!doctype html>
<html><head><script type="module" crossorigin src="/assets/app.js"></script></head>
<body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>
</body></html>
`;

export interface Captured extends CliIO {
  lines: string[];
  errors: string[];
  streamed: string;
  /** Everything the run wrote, in the order it wrote it, the way one terminal shows both streams: the only reading
   * where a line printed on one stream landing mid-sentence on the other can be seen at all. */
  screen: string;
}

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
export function captured(): Captured {
  const io: Captured = {
    lines: [],
    errors: [],
    streamed: "",
    screen: "",
    log: l => {
      io.lines.push(l);
      io.screen += `${l}\n`;
    },
    error: l => {
      io.errors.push(l);
      io.screen += `${l}\n`;
    },
    stream: t => {
      io.streamed += t;
      io.screen += t;
    },
    ask: noPrompt,
    askSecret: noPrompt,
  };
  return io;
}

/** A harness that answers every prompt with reply(prompt) in two text deltas, or fails the turn when the reply is
 * empty, with one Bash call between them carrying its input as JSON the way the adapters send it; a resumed start
 * keeps the session id, as the real one does. The prompt `cut` is a turn the transport cut,
 * as the idle deadline does: a failed done, then an end with no exit code and no result. With `names` its store
 * keeps a person's name for a session, as Claude Code's and Codex's do, and answers what that store made of it:
 * written, no such session, or the machine's own line for a write it refused. */
export const CUT_LINE = "stopped after 15m 00s with no output for 10m";

/** The task that makes a scripted agent stop on a permission question instead of replying, for a case about a thread
 * that needs the person: the turn raises this one prompt and ends when somebody answers it. */
export const ASKS = "ask before running";
export const SCRIPTED_ASK: PermissionAsk = {
  askId: "ask_scripted",
  toolName: "Bash",
  input: JSON.stringify({ command: "wc -l < /etc/hosts" }),
  options: [
    { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
    { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
  ],
};
export function scriptedAgent(reply: (prompt: string) => string, names?: (title: string) => SessionRenameWrite) {
  const starts: HarnessStartOptions[] = [];
  const renames: { sessionId: string; title: string }[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    // Stands in for a harness that reads an image, as both the real ones do; a case about an agent that reads none
    // builds its own adapter.
    attachments: "inline",
    // Stands in for Claude Code, whose launch takes MCP servers; a start naming them on an adapter without this is
    // refused by the runtime.
    mcpServers: true,
    ...(names === undefined
      ? {}
      : {
          renameSession: async (sessionId: string, title: string) => {
            renames.push({ sessionId, title });
            return names(title);
          },
        }),
    start: o => {
      starts.push(o);
      const sessionId = o.resume ?? randomUUID();
      if (o.prompt === ASKS) {
        let settle!: (r: TurnResult) => void;
        const waiting = new Promise<TurnResult>(r => (settle = r));
        queueMicrotask(() => {
          o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
          o.onEvent({ type: "permission.ask", sessionId, ask: SCRIPTED_ASK });
        });
        return {
          localId: sessionId,
          finished: waiting,
          interrupt: async () => {},
          answer: async (askId: string, picked: { optionId: string; outcome: PermissionOutcome }) => {
            const answered: TurnResult = { status: "completed", text: `re: ${picked.outcome}` };
            o.onEvent({ type: "permission.close", sessionId, askId, outcome: picked.outcome, optionId: picked.optionId });
            o.onEvent({ type: "turn.done", sessionId, result: answered });
            o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
            settle(answered);
            return "answered" as const;
          },
        };
      }
      const cut = o.prompt === "cut";
      const text = cut ? "" : reply(o.prompt);
      const result: TurnResult = cut ? { status: "failed", error: CUT_LINE } : text === "" ? { status: "failed", error: "the harness died" } : { status: "completed", text };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
        if (text !== "") {
          o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: text.slice(0, 4) });
          o.onEvent({ type: "turn.delta", sessionId, kind: "tool_use", text: JSON.stringify({ command: "ls" }), toolName: "Bash", toolUseId: "toolu_1" });
          o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: text.slice(4) });
        }
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: cut ? null : 0, sawResult: !cut });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts, renames };
}

/** A harness whose first start never reaches the machine: the turn fails with the runtime's unreached line and no
 * session.start, as a launch the network dropped does; every later start answers like scriptedAgent. */
export const UNREACHED_LINE = "the machine could not be reached from this computer after 6 attempts over 23s";
export function bornDeadAgent(reply: (prompt: string) => string) {
  const starts: HarnessStartOptions[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      starts.push(o);
      const sessionId = o.resume ?? randomUUID();
      if (starts.length === 1) {
        const result: TurnResult = { status: "failed", error: UNREACHED_LINE };
        const finished = Promise.resolve().then(() => {
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: null, sawResult: false });
          return result;
        });
        return { localId: sessionId, finished, interrupt: async () => {} };
      }
      const result: TurnResult = { status: "completed", text: reply(o.prompt) };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
        o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: result.text ?? "" });
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

/** A harness that answers every prompt with reply(prompt) and then never says its session ended: the done lands, the
 * end does not. What a real turn looks like from the client between the reply and the runtime's late exit read. */
export function doneOnlyAgent(reply: (prompt: string) => string) {
  const starts: HarnessStartOptions[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      starts.push(o);
      const sessionId = o.resume ?? randomUUID();
      const result: TurnResult = { status: "completed", text: reply(o.prompt) };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
        o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: result.text ?? "" });
        o.onEvent({ type: "turn.done", sessionId, result });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

/** A harness whose every turn runs until the test releases it with the reply text, or ends interrupted when told to
 * stop, as the real one does; a resumed start keeps the session id, and with steers the turn takes a message mid-way.
 * `envs` is each turn's launch environment, in the order they were launched. */
export function heldAgent(steers: boolean) {
  const starts: HarnessStartOptions[] = [];
  const steered: string[] = [];
  const interrupted: string[] = [];
  const turns: { sessionId: string; onEvent: HarnessStartOptions["onEvent"]; finish: (r: TurnResult) => void; open: Map<string, PermissionAsk> }[] = [];
  /** Every prompt this agent was asked to answer, in order, as the adapter's control channel takes it. */
  const answers: { askId: string; optionId: string; outcome: PermissionOutcome }[] = [];
  const end = (t: (typeof turns)[number], result: TurnResult): void => {
    t.onEvent({ type: "turn.done", sessionId: t.sessionId, result });
    t.onEvent({ type: "session.end", sessionId: t.sessionId, exitCode: 0, sawResult: true });
    t.finish(result);
  };
  const envs: Readonly<Record<string, string>>[] = [];
  const adapter: HarnessAdapterFactory = ctx => ({
    steers,
    start: o => {
      starts.push(o);
      envs.push({ ...ctx.env });
      const sessionId = o.resume ?? randomUUID();
      let finish!: (r: TurnResult) => void;
      const finished = new Promise<TurnResult>(r => (finish = r));
      const turn = { sessionId, onEvent: o.onEvent, finish, open: new Map<string, PermissionAsk>() };
      turns.push(turn);
      queueMicrotask(() => o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" }));
      return {
        localId: sessionId,
        finished,
        interrupt: async () => {
          interrupted.push(sessionId);
          setImmediate(() => end(turn, { status: "interrupted" }));
        },
        answer: async (askId: string, picked: { optionId: string; outcome: PermissionOutcome }) => {
          if (!turn.open.delete(askId)) return "gone" as const;
          answers.push({ askId, optionId: picked.optionId, outcome: picked.outcome });
          o.onEvent({ type: "permission.close", sessionId, askId, outcome: picked.outcome, optionId: picked.optionId });
          return "answered" as const;
        },
        ...(steers
          ? {
              steer: async (prompt: string) => {
                steered.push(prompt);
                return "accepted" as const;
              },
            }
          : {}),
      };
    },
  });
  const release = (turn: number, text: string): void => {
    const t = turns[turn]!;
    t.onEvent({ type: "turn.delta", sessionId: t.sessionId, kind: "text", text });
    end(t, { status: "completed", text });
  };
  /** Raises a permission prompt on a running turn, as a CLI's control channel does, and leaves the turn stopped on it. */
  const ask = (turn: number, raised: PermissionAsk): void => {
    const t = turns[turn]!;
    t.open.set(raised.askId, raised);
    t.onEvent({ type: "permission.ask", sessionId: t.sessionId, ask: raised });
  };
  return { adapter, starts, envs, steered, interrupted, release, ask, answers };
}

/** One scripted tool call: the name and input the harness reports for it, and what it answered when it answered
 * anything, failed the way a harness marks a call that went wrong. */
export interface ScriptedCall {
  toolName: string;
  input: unknown;
  output?: string;
  failed?: boolean;
}

/** The calls alone, which is what a turn that works for minutes before it answers looks like from the client. */
export function toolingAgent(calls: ReadonlyArray<ScriptedCall>, result: TurnResult): HarnessAdapterFactory {
  return sayingAgent(calls, result);
}

/** One piece of a scripted turn's stream that is not a call: what the harness wrote, under the kind it wrote it as
 * and the message it belongs to where it named one. */
export type ScriptedSay = { kind: "text" | "note"; text: string; messageId?: string };

/** A harness whose turn is the pieces it was handed and nothing else, in the order they were handed: the prose of a
 * reply under the harness's own message id, a note the harness wrote about itself, and the calls between them, each
 * with its answer behind it. */
export function sayingAgent(said: ReadonlyArray<ScriptedSay | ScriptedCall>, result: TurnResult): HarnessAdapterFactory {
  return () => ({
    steers: false,
    start: o => {
      const sessionId = o.resume ?? randomUUID();
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
        for (const [i, piece] of said.entries()) {
          if ("kind" in piece) {
            o.onEvent({ type: "turn.delta", sessionId, kind: piece.kind, text: piece.text, ...(piece.messageId !== undefined ? { messageId: piece.messageId } : {}) });
            continue;
          }
          o.onEvent({ type: "turn.delta", sessionId, kind: "tool_use", text: JSON.stringify(piece.input), toolName: piece.toolName, toolUseId: `toolu_${i}` });
          if (piece.output !== undefined) o.onEvent({ type: "turn.delta", sessionId, kind: "tool_result", text: piece.output, toolUseId: `toolu_${i}`, isError: piece.failed === true });
        }
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
}

/** A harness whose turn never ends: the session starts and nothing more arrives. */
export function stuckAgent(): HarnessAdapterFactory {
  return () => ({
    steers: false,
    start: o => {
      const sessionId = randomUUID();
      queueMicrotask(() => o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" }));
      return { localId: sessionId, finished: new Promise<TurnResult>(() => {}), interrupt: async () => {} };
    },
  });
}

/** One adapter event as a case writes it, the session id left to the fixture; distributive, so each arm of the union
 * keeps its own fields. */
type WithoutSession<T> = T extends unknown ? Omit<T, "sessionId"> : never;

/** A harness whose turn is the test's to drive: it starts, then says what the case tells it to say and ends when the
 * case ends it, so a case can read what a client shows while a turn is still running. */
export function holdingAgent() {
  const starts: HarnessStartOptions[] = [];
  let end: (result: TurnResult) => void = () => {};
  let sessionId = "";
  let emit: (event: AdapterEvent) => void = () => {};
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    mcpServers: true,
    start: o => {
      starts.push(o);
      sessionId = randomUUID();
      emit = o.onEvent;
      o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-5" });
      return { localId: sessionId, finished: new Promise<TurnResult>(r => (end = r)), interrupt: async () => end({ status: "interrupted" }) };
    },
  });
  return {
    adapter,
    starts,
    /** One event from the running turn, its session id filled in. */
    say: (event: WithoutSession<AdapterEvent>) => emit({ ...event, sessionId } as AdapterEvent),
    finish: (result: TurnResult) => end(result),
  };
}

/** The provider's answer to a command on a paused machine, word for word. */
export const NOT_RUNNING = "Sandbox is not running";

/** The guest side of the exec stream: the launch lands, one poll hands over the log with the exit code; with no exit
 * the command reads as still running. A paused machine refuses every command as the provider does. */
export function execGuest(backend: StubBackend, output: string, exit: number | undefined) {
  const base = backend.execImpl;
  backend.execImpl = (m, cmd): Promise<ExecResult> | ExecResult => {
    if (m.paused) throw new Error(NOT_RUNNING);
    if (cmd.includes("base64 -d")) return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
    if (cmd.includes("kill -TERM") || cmd.includes("kill -KILL")) return { exitCode: 0, stdout: "", stderr: "" };
    const sentinel = /(__WSP_EOF_[a-z0-9]+__)/.exec(cmd)?.[1];
    if (sentinel !== undefined) {
      const from = Number(/tail -c \+(\d+)/.exec(cmd)?.[1] ?? "1") - 1;
      const chunk = Buffer.from(output).subarray(from).toString("base64");
      return { exitCode: 0, stdout: `${chunk}\n${sentinel} ${exit ?? ""} ${exit === undefined ? "up" : "down"}\n`, stderr: "" };
    }
    return base(m, cmd);
  };
}

/** A folder of one file landing on the machine, the way the app's import hands it to the runtime. */
export const projectBundler = (): ProjectBundler => ({
  plan: async () => ({ source: "/Users/dev/proj", repo: true, files: 1, bytes: 20, secrets: [], excluded: [], skipped: [], agents: [] }),
  pack: async () => ({ tar: tarOf([{ path: "src/index.ts", mode: 0o644, content: "export const a = 1;\n" }]), files: 1, bytes: 20, cut: [], rewritten: [] }),
  packState: async () => {
    throw new Error("no agent state here");
  },
});

export const EXPORT_SOURCE = "/root/work/proj";
const CLAUDE_GUEST_HOME = "/root/.claude-cfg";
/** The one Claude Code session on the machine for the folder, as the export brings it down. */
export const EXPORT_SESSION = (cwd: string): string => `{"type":"user","cwd":"${cwd}","sessionId":"S1"}\n`;

/** The guest side of an export: the folder is there, its archive and the Claude Code state root come down for the
 * paths the machine packs them at, and only that root exists among the agents' homes. */
export function exportGuest(backend: StubBackend): { sources: string[] } {
  const base = backend.execImpl;
  const tars = new Map<string, Buffer>();
  const sources: string[] = [];
  backend.downloads = path => tars.get(path) ?? tarOf([]);
  backend.execImpl = (m, cmd): Promise<ExecResult> | ExecResult => {
    const probed = /^test -d '([^']+)'/.exec(cmd)?.[1];
    if (probed !== undefined) {
      sources.push(probed);
      return { exitCode: 0, stdout: "yes\n", stderr: "" };
    }
    // The modules' listings carry their home base64 encoded, and only Claude Code's names anything here.
    if (cmd.startsWith("set -e\npython3 -c ")) {
      const claude = cmd.includes(Buffer.from(JSON.stringify(CLAUDE_GUEST_HOME), "utf8").toString("base64"));
      return { exitCode: 0, stdout: claude ? `${CLAUDE_GUEST_HOME}/projects/-root-work-proj\n` : "", stderr: "" };
    }
    const out = /tar czf '([^']+)'/.exec(cmd)?.[1];
    if (out !== undefined && cmd.includes("find '.'")) {
      tars.set(out, tarOf([{ path: "./src/index.ts", mode: 0o644, content: "export const a = 1;\n" }, { path: "./.env", mode: 0o600, content: "TOKEN=x\n" }]));
      return { exitCode: 0, stdout: "node_modules\n", stderr: "" };
    }
    if (out !== undefined) {
      tars.set(out, tarOf([{ path: "root/.claude-cfg/projects/-root-work-proj/S1.jsonl", mode: 0o644, content: EXPORT_SESSION(EXPORT_SOURCE) }]));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const sized = /^wc -c < '([^']+)'/.exec(cmd)?.[1];
    if (sized !== undefined) return { exitCode: 0, stdout: `${tars.get(sized)?.length ?? 0}\n`, stderr: "" };
    return base(m, cmd);
  };
  return { sources };
}

/** Every script a launch carried to the machine, decoded, oldest first. */
export function launchedScripts(backend: StubBackend): string[] {
  return backend.machines[0]!.execLog.filter(cmd => cmd.includes("base64 -d")).map(launch => Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(launch)![1]!, "base64").toString("utf8"));
}

/** The script the first launch carried to the machine, decoded. */
export function launchedScript(backend: StubBackend): string {
  return launchedScripts(backend)[0]!;
}

/** The project every workspace in a host test stands on, and a workspace of it. A workspace is one project's copy,
 * so a test about a verb, a table or a thread still needs one; these are the two lines that make them, and the one
 * place a host test writes down what a project record is. */
export function projectOn(rt: ProjectMaker, computer?: string, source?: string, named?: { name?: string; base?: string }): Promise<ProjectView> {
  return projectOnRuntime(rt, computer, source, named);
}

export function createOn(rt: ProjectMaker & WorkspaceMaker, o: CreateOn, origin?: Caller): Promise<CreatedWorkspace> {
  return createOnRuntime(rt, o, origin);
}

type ProjectMaker = { projects: Pick<Runtime["projects"], "add" | "computers"> };
type WorkspaceMaker = { workspaces: Pick<Runtime["workspaces"], "create" | "get"> };
