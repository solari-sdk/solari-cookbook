// SPDX-License-Identifier: AGPL-3.0-only
// Normalizes `codex exec --json` output into the event set the runtime
// consumes. The shapes are codex-rs/exec/src/exec_events.rs at rust-v0.153.0:
// thread.started names the thread a resume takes, items start and complete
// under one id each, turn.completed carries usage, turn.failed the error.
import { randomUUID } from "node:crypto";
import { RUN_EXIT_MS, codexKeyRefusedLine, codexMissingEnvLine, codexNotSignedInLine, codexReconnectLine, endAfterResult, endRun, titlePrompt } from "@wsp/protocol";
import type { AdapterAttachOptions, AdapterEvent, McpServerSpec, ExecStream, ExecStreamFactory, HarnessCatalogAnswer, SessionRenamer, SessionTitleMaker, SessionTitleReader, TurnImage, TurnRefusal, TurnResult } from "@wsp/protocol";
import { catalogProbeCommand, parseCatalogProbe } from "./catalog.js";
import { INTERRUPT_GRACE_MS, buildCommand, buildEnv } from "./command.js";
import { parseRename, parseSessionTitle, parseTitleFor, renameCommand, sessionTitleCommand, titleForCommand } from "./session-title.js";

export interface CodexStartOptions {
  prompt: string;
  /** The thread id an earlier turn announced; the CLI reloads that thread. */
  resume?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
  /** Images for this turn, read off their paths: this CLI reads each off the machine's disk, where the runtime
   * landed it under the thread's images folder before the start. */
  images?: readonly TurnImage[];
  /** MCP servers this turn gets besides the ones its config names, each rendered as a config override. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
  onEvent: (event: AdapterEvent) => void;
}

export interface CodexSession {
  /** Registry key: the resume id, or one minted here, since the CLI announces its thread id only once it runs. */
  readonly localId: string;
  /** The id thread.started announced, equal to localId until it does. */
  readonly threadId: string;
  /** The line the launch ran; absent on a session attached to a run some earlier process launched. */
  readonly command?: string;
  /** What a later host process attaches to this turn by; absent when its run dies with this process. */
  readonly run?: string;
  /** The process this turn leads on the computer the host runs on, where it runs there; absent on a turn running on
   * another machine. */
  readonly pid?: number;
  readonly finished: Promise<TurnResult>;
  interrupt(): Promise<void>;
}

export interface CodexAdapterDeps {
  exec: ExecStreamFactory;
  /** CODEX_HOME on the machine. */
  home: string;
  /** The catalog's command for signing codex in on a machine, named when a turn fails for want of one. */
  login: string;
  /** The API key the vault holds for this agent; set on every turn's environment. */
  apiKey?: string;
  /** The variable that key travels under, for the sentence a turn fails with when the provider turns it down.
   * Absent where no key was handed, which is what tells a refused key from no credential at all. */
  keyEnv?: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  interruptGraceMs?: number;
  /** How long the CLI gets to exit on its own after its turn's result, before its process and its tree are ended
   * for it. */
  resultExitMs?: number;
  /** How long a run of Reconnecting error events with no turn progress may last before the turn is failed. */
  reconnectStallMs?: number;
}

export interface CodexAdapter {
  start(options: CodexStartOptions): CodexSession;
  /** Re-opens a turn this CLI is still running on the machine, by the run handle the launch reported; `gone` is the
   * machine's own answer that it no longer holds the run, and nothing is emitted for one. A machine that answers
   * nothing rejects. Absent when the exec factory's runs die with the process that launched them. */
  attach?(options: AdapterAttachOptions): Promise<CodexSession | "gone">;
  readonly sessions: ReadonlyMap<string, CodexSession>;
  /** `codex exec` reads its prompt and closes stdin; nothing reaches a running turn. */
  readonly steers: false;
  /** The CLI takes images as files on `-i`, so each one lands on the machine before the turn starts. */
  readonly attachments: "file";
  /** Servers ride the launch as `-c mcp_servers.<name>...` overrides over the config under CODEX_HOME. */
  readonly mcpServers: true;
  /** Makes the binary describe itself under the same home as a session, without running a turn. */
  probeCatalog(exec: (command: string) => Promise<string>): Promise<HarnessCatalogAnswer>;
  /** What the CLI's thread index calls a thread: the name the person gave it, or the title it derived. */
  sessionTitle: SessionTitleReader;
  /** Names the thread in that same index, in the column the CLI's own rename writes. */
  renameSession: SessionRenamer;
  /** Asks the CLI itself, in one read-only turn, for a name for a thread it has just replied in. */
  titleFor: SessionTitleMaker;
  readonly env: Readonly<Record<string, string>>;
}

type Item = Record<string, unknown> & { id: string; type: string };

/** The last lines the process printed that were not events: codex's stderr shares the log with its stdout. */
const STDERR_TAIL_LINES = 5;
/** A provider that wants an OpenAI login gets a 401, retried in error events, then the process dies. */
const UNAUTHORIZED = /401 Unauthorized/;
/** A provider whose env_key variable is unset: the CLI names the variable and fails the turn at once. */
const MISSING_ENV = /Missing environment variable: `([^`]+)`/;
/** A provider that refuses connections: the CLI prints this forever, whatever its retry settings say. */
const RECONNECTING = /^Reconnecting\.\.\./;
const RECONNECT_STALL_MS = 90_000;

/** What the CLI said after the status it refused on, as a clause a sentence can carry: its own colon and spaces
 * off the front, and the bracket it wraps a status in closed off the end. Empty where it said nothing. */
function refusedBecause(message: string): string {
  const at = UNAUTHORIZED.exec(message);
  if (at === null) return "";
  const tail = message.slice(at.index + at[0].length).split("\n")[0] ?? "";
  return (tail.replace(/^[:\s]+/, "").split(")")[0] ?? "").trim();
}

/** The words for a failure the CLI reported in its own, with what wsp classes it as where it claims a cause;
 * undefined when the CLI's message stands as it is. A 401 is two different things to the person: with a key
 * handed, the provider turned that key down and signing in again fixes nothing; with none, nothing was signed in
 * there at all. */
function failureWords(message: string, login: string, keyEnv?: string): { line: string; cause?: TurnRefusal } | undefined {
  if (UNAUTHORIZED.test(message)) {
    const line = keyEnv === undefined ? codexNotSignedInLine(login) : codexKeyRefusedLine(keyEnv, refusedBecause(message), login);
    return { line, cause: "sign-in" };
  }
  const missing = MISSING_ENV.exec(message);
  return missing === null ? undefined : { line: codexMissingEnvLine(missing[1]!) };
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseLine(raw: string): Record<string, unknown> | undefined {
  const line = raw.trim();
  if (!line.startsWith("{")) return undefined;
  try {
    const event = rec(JSON.parse(line));
    return event !== undefined && typeof event.type === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}

function itemOf(event: Record<string, unknown>): Item | undefined {
  const item = rec(event.item);
  const id = str(item?.id);
  const type = str(item?.type);
  return item !== undefined && id !== undefined && type !== undefined ? ({ ...item, id, type } as Item) : undefined;
}

const changeLines = (changes: unknown): string =>
  Array.isArray(changes)
    ? changes
        .map(rec)
        .filter((c): c is Record<string, unknown> => c !== undefined)
        .map(c => `${str(c.kind) ?? "change"} ${str(c.path) ?? ""}`.trim())
        .join("\n")
    : "";

/** Each item as the deltas a timeline draws: a call when it starts (or lands whole), its result when it completes. */
function itemDeltas(phase: string, item: Item, sessionId: string): AdapterEvent[] {
  const done = phase === "item.completed";
  const delta = (fields: Omit<Extract<AdapterEvent, { type: "turn.delta" }>, "type" | "sessionId">): AdapterEvent => ({ type: "turn.delta", sessionId, ...fields });
  switch (item.type) {
    case "agent_message":
      return done ? [delta({ kind: "text", text: str(item.text) ?? "", messageId: item.id })] : [];
    case "reasoning":
      return done ? [delta({ kind: "thinking", text: str(item.text) ?? "" })] : [];
    case "command_execution": {
      if (phase === "item.started") return [delta({ kind: "tool_use", text: JSON.stringify({ command: str(item.command) ?? "" }), toolName: item.type, toolUseId: item.id })];
      if (!done) return [];
      return [delta({ kind: "tool_result", text: str(item.aggregated_output) ?? "", toolUseId: item.id, isError: str(item.status) !== "completed" })];
    }
    case "file_change":
      return done
        ? [
            delta({ kind: "tool_use", text: JSON.stringify({ changes: item.changes ?? [] }), toolName: item.type, toolUseId: item.id }),
            delta({ kind: "tool_result", text: changeLines(item.changes), toolUseId: item.id, isError: str(item.status) !== "completed" }),
          ]
        : [];
    case "mcp_tool_call": {
      const name = `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`;
      if (phase === "item.started") return [delta({ kind: "tool_use", text: JSON.stringify(item.arguments ?? {}), toolName: name, toolUseId: item.id })];
      if (!done) return [];
      const failed = str(item.status) !== "completed";
      const text = failed ? (str(rec(item.error)?.message) ?? "") : JSON.stringify(rec(item.result)?.content ?? []);
      return [delta({ kind: "tool_result", text, toolUseId: item.id, isError: failed })];
    }
    case "web_search":
      return done
        ? [
            delta({ kind: "tool_use", text: JSON.stringify({ query: str(item.query) ?? "" }), toolName: item.type, toolUseId: item.id }),
            delta({ kind: "tool_result", text: str(item.query) ?? "", toolUseId: item.id, isError: false }),
          ]
        : [];
    case "error":
      // The CLI's own note about itself, a warning about this machine's codex configuration among them, which it
      // writes before its first output and goes on to answer past. Nothing of the turn failed here.
      return done ? [delta({ kind: "note", text: str(item.message) ?? "" })] : [];
    default:
      return [];
  }
}

export function createCodexAdapter(deps: CodexAdapterDeps): CodexAdapter {
  const sessions = new Map<string, CodexSession>();
  const env = buildEnv({ base: deps.baseEnv, home: deps.home, ...(deps.apiKey !== undefined ? { apiKey: deps.apiKey } : {}) });

  /** Everything a turn is once its stream exists. The launch and the attach differ only in where the stream came
   * from and in what is already known: an attached turn's thread, model and folder come off the row that outlived
   * the host, since the CLI announces each of them once and that line may already be behind the reader. */
  const follow = (o: { stream: ExecStream; localId: string; startedAt: number; command?: string; model?: string; cwd?: string; onEvent: (event: AdapterEvent) => void }): CodexSession => {
    const { stream, localId, startedAt } = o;

    let threadId = localId;
    let sawResult = false;
    let interruptRequested = false;
    let turnResult: TurnResult | undefined;
    let lastText: string | undefined;
    /** The last failure the stream showed, if any, in wsp's words and under the cause it claims: a 401, a missing
     * env var, or the reconnect loop. */
    let words: { line: string; cause?: TurnRefusal } | undefined;
    /** The last top-level error event: what the CLI said last when it dies without a turn.failed. */
    let lastError: string | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let stalledAt: number | undefined;
    const stderrTail: string[] = [];

    const emit = (event: AdapterEvent): void => o.onEvent(event);

    const escalate = (): Promise<void> => endRun(stream, deps.interruptGraceMs ?? INTERRUPT_GRACE_MS);
    /** Armed at the turn's result: the CLI ends its own process there, and one that does not is ended with its tree. */
    const endAfter = (): void => void endAfterResult(stream, deps.resultExitMs ?? RUN_EXIT_MS, deps.interruptGraceMs ?? INTERRUPT_GRACE_MS).catch(() => {});
    const progress = (): void => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = undefined;
      stalledAt = undefined;
    };
    /** Armed by the first Reconnecting line after the last progress; a run that outlives it ends the turn in words. */
    const reconnecting = (): void => {
      if (stallTimer !== undefined) return;
      stalledAt = Date.now();
      stallTimer = setTimeout(() => {
        words = { line: codexReconnectLine(Date.now() - (stalledAt ?? startedAt)) };
        void escalate();
      }, deps.reconnectStallMs ?? RECONNECT_STALL_MS);
    };

    const finished = (async (): Promise<TurnResult> => {
      let streamError: string | undefined;
      try {
        for await (const raw of stream.lines) {
          const event = parseLine(raw);
          if (event === undefined) {
            const text = raw.trim();
            words = failureWords(text, deps.login, deps.keyEnv) ?? words;
            if (text.length > 0 && stderrTail.push(text) > STDERR_TAIL_LINES) stderrTail.shift();
            continue;
          }
          const type = str(event.type);
          if (type !== "error") progress();
          switch (type) {
            case "thread.started": {
              threadId = str(event.thread_id) ?? threadId;
              emit({ type: "session.start", sessionId: threadId, ...(o.model !== undefined ? { model: o.model } : {}), ...(o.cwd !== undefined ? { cwd: o.cwd } : {}) });
              break;
            }
            case "item.started":
            case "item.updated":
            case "item.completed": {
              const item = itemOf(event);
              if (item === undefined) break;
              if (type === "item.completed" && item.type === "agent_message") lastText = str(item.text);
              for (const delta of itemDeltas(type, item, threadId)) emit(delta);
              break;
            }
            case "turn.completed": {
              sawResult = true;
              turnResult = { status: "completed", durationMs: Date.now() - startedAt, ...(lastText !== undefined ? { text: lastText } : {}), ...(rec(event.usage) !== undefined ? { usage: rec(event.usage) } : {}) };
              emit({ type: "turn.done", sessionId: threadId, result: turnResult });
              endAfter();
              break;
            }
            case "turn.failed": {
              sawResult = true;
              const message = str(rec(event.error)?.message) ?? "codex reported a failed turn";
              words = failureWords(message, deps.login, deps.keyEnv) ?? words;
              turnResult = { status: "failed", durationMs: Date.now() - startedAt, error: words?.line ?? message, ...(words?.cause !== undefined ? { refusal: words.cause } : {}) };
              emit({ type: "turn.done", sessionId: threadId, result: turnResult });
              endAfter();
              break;
            }
            case "error": {
              const message = str(event.message) ?? "";
              lastError = message;
              words = failureWords(message, deps.login, deps.keyEnv) ?? words;
              if (RECONNECTING.test(message)) reconnecting();
              break;
            }
            default:
              break;
          }
        }
      } catch (cause) {
        // The transport ended the turn itself and its message says why; that message is the turn's error.
        streamError = cause instanceof Error ? cause.message : String(cause);
      }
      const exitCode = await stream.exited;
      progress();
      if (turnResult === undefined) {
        const reason = lastError ?? (stderrTail.length === 0 ? undefined : stderrTail.join("\n"));
        const died = `codex exited with code ${String(exitCode)} before its turn ended${reason === undefined ? "" : `: ${reason}`}`;
        turnResult = interruptRequested
          ? { status: "interrupted" }
          : words !== undefined
            ? { status: "failed", error: words.line, ...(words.cause !== undefined ? { refusal: words.cause } : {}) }
            : { status: "failed", error: streamError ?? died };
        emit({ type: "turn.done", sessionId: threadId, result: turnResult });
      }
      emit({ type: "session.end", sessionId: threadId, exitCode, sawResult });
      return turnResult;
    })();

    const session: CodexSession = {
      localId,
      get threadId() {
        return threadId;
      },
      ...(o.command !== undefined ? { command: o.command } : {}),
      ...(stream.run !== undefined ? { run: stream.run } : {}),
      ...(stream.pid !== undefined ? { pid: stream.pid } : {}),
      finished,
      interrupt: async () => {
        interruptRequested = true;
        await escalate();
      },
    };
    sessions.set(localId, session);
    return session;
  };

  /** An image reaches this CLI as a file, so one that arrived with no path never travelled the runtime's file road
   * and the turn is refused rather than started without it. */
  const imagePathOf = (image: TurnImage): string => {
    if (image.path === undefined) throw new Error("codex reads images off the machine's disk; this one has no path on it");
    return image.path;
  };

  const start = (options: CodexStartOptions): CodexSession => {
    if (options.contextWindow !== undefined) throw new Error("codex takes no context window");
    const localId = options.resume ?? randomUUID();
    const command = buildCommand({
      prompt: options.prompt,
      resume: options.resume,
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
      ...(options.images !== undefined ? { images: options.images.map(image => imagePathOf(image)) } : {}),
      ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}),
    });
    return follow({
      stream: deps.exec(command, { env: { ...env } }),
      localId,
      startedAt: Date.now(),
      command,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      onEvent: options.onEvent,
    });
  };

  const attach = deps.exec.attach?.bind(deps.exec);

  const probeCatalog = (exec: (command: string) => Promise<string>): Promise<HarnessCatalogAnswer> =>
    exec(catalogProbeCommand({ home: deps.home, baseEnv: deps.baseEnv })).then(stdout => parseCatalogProbe(stdout, deps.login));

  return {
    start,
    attachments: "file",
    ...(attach !== undefined
      ? {
          attach: async (options: AdapterAttachOptions) => {
            const stream = await attach(options.run, { input: false });
            return stream === "gone"
              ? "gone"
              : follow({
                  stream,
                  localId: options.sessionId,
                  startedAt: options.startedAt,
                  ...(options.model !== undefined ? { model: options.model } : {}),
                  ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
                  onEvent: options.onEvent,
                });
          },
        }
      : {}),
    sessions,
    steers: false,
    mcpServers: true,
    probeCatalog,
    sessionTitle: (threadId, exec) => exec(sessionTitleCommand({ home: deps.home, threadId })).then(parseSessionTitle),
    renameSession: (threadId, title, exec) => exec(renameCommand({ home: deps.home, threadId, title })).then(parseRename),
    titleFor: (turn, exec) =>
      exec(
        titleForCommand({
          home: deps.home,
          prompt: titlePrompt(turn.opening, turn.reply),
          ...(turn.model !== undefined ? { model: turn.model } : {}),
          ...(deps.baseEnv !== undefined ? { baseEnv: deps.baseEnv } : {}),
        }),
      ).then(parseTitleFor),
    env,
  };
}
