// SPDX-License-Identifier: AGPL-3.0-only
// A daemon link whose ptys are scripted: every op is recorded, typed bytes are
// kept per pty, a complete line (ending in \r) is echoed back the way a tty
// would, followed by what a sign-in line prints as its tool starts, and handed
// to the script, and the test pushes output and exits. A command put in a file
// by an exec is kept, and a typed line that reads that file records it as run.
import { TOOL_STARTS, type PtyLink } from "../src/signin-relay.js";

/** A typed line's read of a staged command and the removal of its folder. */
const STAGED_READ = /^c=\$\((?:< |cat )'([^']+)\/line'\); rm -rf -- '[^']+'; /;

/** What a sign-in line prints as its tool starts, as typed. */
const MARKS_TOOL = "printf '\\036'";

export interface FakePty {
  id: string;
  created: Record<string, unknown>;
  /** Every pty.write payload in order. */
  writes: string[];
  attached: boolean;
  killed: boolean;
  resizes: { cols: number; rows: number }[];
  exited: boolean;
  /** The staged command the typed line ran, once one did. */
  ran?: string;
}

export interface FakePtyLink extends PtyLink {
  ops: { op: string; extra: Record<string, unknown> }[];
  /** Each staged command by its folder, and whether that folder is still there. */
  staged: Map<string, { command: string; cleared: boolean }>;
  ptys: FakePty[];
  /** How many links were dialled through dial(). */
  dials: number;
  /** A fresh link view over the same ptys, the way a redial gives one; its closed settles on drop(). */
  dial(): PtyLink;
  /** The latest dialled view goes away: closed settles and its ops reject the way a dead socket's do. */
  drop(): void;
  /** What each pty's shell prints as it is attached, before any line is typed. */
  banner?: string;
  /** Called with each complete typed line, after its echo; a line that ran a staged command comes with that command
   * standing where the line reads it. */
  script?: (pty: FakePty, line: string) => void;
  emit(e: Record<string, unknown>): void;
  data(pty: FakePty, text: string): void;
  exit(pty: FakePty, exitCode: number): void;
  /** True when the pty got exactly this typed after its command line (a Ctrl-C, say). */
  typed(pty: FakePty, s: string): boolean;
}

export function fakePtyLink(): FakePtyLink {
  const fns = new Set<(e: Record<string, unknown>) => void>();
  const partial = new Map<string, string>();
  let seq = 0;
  let folders = 0;
  const views: { dropped: boolean; settle: () => void }[] = [];
  const link: FakePtyLink = {
    ops: [],
    staged: new Map(),
    ptys: [],
    dials: 0,
    dial() {
      let settle: () => void = () => {};
      const closed = new Promise<void>(r => (settle = r));
      const view = { dropped: false, settle };
      views.push(view);
      link.dials += 1;
      return {
        op: (op, extra) => (view.dropped ? Promise.reject(new Error("daemon connection closed 1006")) : link.op(op, extra)),
        onEvent: fn => link.onEvent(fn),
        closed,
      };
    },
    drop() {
      const view = views.at(-1);
      if (!view) throw new Error("nothing dialled");
      view.dropped = true;
      view.settle();
    },
    async op(op, extra = {}) {
      link.ops.push({ op, extra });
      const find = (): FakePty => {
        const p = link.ptys.find(x => x.id === extra["ptyId"]);
        if (!p) throw new Error(`no pty ${String(extra["ptyId"])}`);
        return p;
      };
      switch (op) {
        case "pty.create": {
          const pty: FakePty = { id: `pty_${++seq}`, created: extra, writes: [], attached: false, killed: false, resizes: [], exited: false };
          link.ptys.push(pty);
          return { ok: true, ptyId: pty.id, pid: 100 + seq };
        }
        case "pty.attach":
          find().attached = true;
          if (link.banner !== undefined) link.data(find(), link.banner);
          return { ok: true, ptyId: extra["ptyId"] };
        case "pty.write": {
          const pty = find();
          const s = String(extra["data"]);
          pty.writes.push(s);
          const buf = (partial.get(pty.id) ?? "") + s;
          const lines = buf.split("\r");
          partial.set(pty.id, lines.pop() ?? "");
          for (const line of lines) {
            link.data(pty, `${line}\r\n`);
            const read = STAGED_READ.exec(line);
            const held = read === null ? undefined : link.staged.get(read[1]!);
            if (held !== undefined) pty.ran = held.command;
            if (line.includes(MARKS_TOOL)) link.data(pty, TOOL_STARTS);
            link.script?.(pty, held === undefined ? line : line.slice(read![0].length).replace('eval "$c"', held.command).replace('"$c"', held.command));
          }
          return { ok: true };
        }
        case "pty.resize":
          find().resizes.push({ cols: Number(extra["cols"]), rows: Number(extra["rows"]) });
          return { ok: true };
        case "exec": {
          if (extra["stdin"] !== undefined) {
            const dir = `/staged/${++folders}`;
            link.staged.set(dir, { command: Buffer.from(String(extra["stdin"]), "base64").toString("utf8"), cleared: false });
            return { exitCode: 0, stdout: dir, stderr: "", truncated: false };
          }
          const cleared = /^rm -rf -- '(\/staged\/\d+)'$/.exec(String(extra["cmd"]))?.[1];
          if (cleared !== undefined) link.staged.get(cleared)!.cleared = true;
          return { ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false };
        }
        case "pty.kill":
          find().killed = true;
          return { ok: true };
        default:
          return { ok: true };
      }
    },
    onEvent(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    emit(e) {
      for (const f of fns) f(e);
    },
    data(pty, text) {
      link.emit({ type: "pty.data", ptyId: pty.id, data: text });
    },
    exit(pty, exitCode) {
      pty.exited = true;
      link.emit({ type: "pty.exit", ptyId: pty.id, exitCode });
    },
    typed(pty, s) {
      return pty.writes.slice(1).includes(s);
    },
  };
  return link;
}

/** The execs a caller ran on the link, leaving out the ones that staged a command or removed it. */
export function execsBeside(link: FakePtyLink): { op: string; extra: Record<string, unknown> }[] {
  return link.ops.filter(o => o.op === "exec" && o.extra["stdin"] === undefined && !/^rm -rf -- '\/staged\//.test(String(o.extra["cmd"])));
}
