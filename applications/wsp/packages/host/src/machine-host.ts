// SPDX-License-Identifier: AGPL-3.0-only
// The collector's Host over any machine this host reaches: a computer you
// joined over its link, a workspace, a fork. Every line runs as the login the
// computer was added with (asLogin). Each round trip is a frame over a link
// with its own bound, so the reads a caller asks for together (every stat of
// a Promise.all) ride one command, and an answer the road cut short is a
// refusal named on the host rather than a file that seems not to be there.
import type { Host, HostExec, HostFs, RunOptions, Stat } from "@wsp/collect";
import { EXEC_TIMEOUT_MAX_MS, shellQuote } from "@wsp/protocol";
import { asLogin, stageAsLogin, type Machine, type TargetLogin } from "@wsp/engine";

/** A Host whose reads may have been refused: one line per read that could not answer whole. */
export interface MachineHost extends Host {
  readonly refused: string[];
}

/** The largest file a read takes; a config past it is named, not read. */
export const MACHINE_READ_CAP = 1024 * 1024;
/** How many bytes of arguments one command carries, under the 16 KB a daemon takes for a command's body. */
const ARGS_PER_FRAME = 12 * 1024;
const BATCH_MS = 20_000;
const END = "\x1eEND";

/** One batch per kind of read: the loop over its items, one answer line per item, then the end mark. */
function scripts(platform: TargetLogin["platform"]): Record<"stat" | "which" | "read" | "list", string> {
  const size = platform === "darwin" ? "stat -f '%z %m'" : "stat -c '%s %Y'";
  const mtime = platform === "darwin" ? "stat -f %m" : "stat -c %Y";
  return {
    stat: `for p; do if [ -d "$p" ]; then printf 'd %s %s\\n' "$(du -sk "$p" 2>/dev/null | cut -f1)" "$(${mtime} "$p")"; elif [ -f "$p" ]; then printf 'f %s\\n' "$(${size} "$p")"; else echo -; fi; done`,
    which: 'for b; do if command -v "$b" >/dev/null 2>&1; then echo 1; else echo 0; fi; done',
    read: `for f; do if [ -f "$f" ] && [ -r "$f" ]; then if [ "$(wc -c < "$f")" -gt ${MACHINE_READ_CAP} ]; then echo '!'; else base64 < "$f" | tr -d '\\n'; echo; fi; else echo -; fi; done`,
    list: 'for d; do ls -1A "$d" 2>/dev/null | base64 | tr -d \'\\n\'; echo; done',
  };
}

/** The items cut into runs whose quoted words fit one command. */
function chunks(items: readonly string[]): string[][] {
  const out: string[][] = [];
  let run: string[] = [];
  let bytes = 0;
  for (const item of items) {
    const n = shellQuote(item).length + 1;
    if (run.length > 0 && bytes + n > ARGS_PER_FRAME) {
      out.push(run);
      run = [];
      bytes = 0;
    }
    run.push(item);
    bytes += n;
  }
  if (run.length > 0) out.push(run);
  return out;
}

/** Collects the items asked in one turn of the event loop and answers them from one command per run of them. */
interface Waiting<T> {
  item: string;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function batched<T>(flush: (items: string[]) => Promise<T[]>): (item: string) => Promise<T> {
  let queue: Waiting<T>[] | undefined;
  return item =>
    new Promise<T>((resolve, reject) => {
      if (queue === undefined) {
        const q: Waiting<T>[] = [];
        queue = q;
        setImmediate(() => {
          queue = undefined;
          const items = [...new Set(q.map(e => e.item))];
          flush(items).then(
            answers => {
              const at = new Map(items.map((item, i) => [item, answers[i]!]));
              for (const e of q) e.resolve(at.get(e.item)!);
            },
            (e: unknown) => {
              for (const w of q) w.reject(e);
            },
          );
        });
      }
      queue!.push({ item, resolve, reject });
    });
}

const decoded = (line: string): string => Buffer.from(line, "base64").toString("utf8");
const ok = (res: { exitCode: number; stdout: string }): string | undefined => (res.exitCode === 0 ? res.stdout : undefined);

/** Reads NUL-separated names and values off the line's own stdin into its environment, before anything else runs. */
const ENV_FROM_STDIN = `while IFS= read -r -d '' k && IFS= read -r -d '' v; do export "$k=$v"; done; `;

/** Opens the file of names and values at $1, removes its folder $2, reads the pairs into its environment as data, then
 * becomes the command after them. */
const ENV_FROM_FILE = `bash -c ${shellQuote(`exec 4< "$1" || exit 1; rm -rf -- "$2"; while IFS= read -r -d '' k <&4 && IFS= read -r -d '' v <&4; do export "$k=$v"; done; exec 4<&-; shift 2; exec "$@"`)} bash`;
const STAGE_MS = 20_000;

/** How the variables a run is given reach it, never on a command line another login on that computer can read: over
 * the command's stdin where the road hands it over, as a computer you joined does, else in a file landed by the
 * machine's own byte road into a folder only that login can read, gone before the command runs. */
export type EnvRoad = { stdin: true } | { land: Pick<Machine, "id" | "putBytes" | "uploadUrl"> };

export function machineHost(machine: Pick<Machine, "exec">, login: TargetLogin, envRoad: EnvRoad): MachineHost {
  const refused: string[] = [];
  const refuse = (line: string): void => {
    if (!refused.includes(line)) refused.push(line);
  };
  const script = scripts(login.platform);
  /** Every line of the loop's answer for these items, one per item; undefined for an item the answer did not reach. */
  const answer = async (what: string, loop: string, items: string[]): Promise<(string | undefined)[]> => {
    const out: (string | undefined)[] = [];
    for (const run of chunks(items)) {
      const res = await machine.exec(asLogin(login, `set -- ${run.map(shellQuote).join(" ")}; ${loop}; printf '\\036END\\n'`), { timeoutMs: BATCH_MS });
      const lines = res.stdout.split("\n");
      const whole = res.stdout.trimEnd().endsWith(END);
      const said = res.stderr.trim().split("\n")[0] ?? "";
      // A road that ran nothing (runuser refusing the login, a shell that would not start) says why on stderr.
      if (!whole) refuse(res.exitCode !== 0 && said !== "" ? `${what}: ${said}` : `${what}: the answer for ${run.length === 1 ? run[0] : `${run.length} paths`} was cut short`);
      for (let i = 0; i < run.length; i++) out.push(whole || i < lines.length - 1 ? lines[i] : undefined);
    }
    return out;
  };
  const stat = batched<Stat | undefined>(async items =>
    (await answer("stat", script.stat, items)).map(line => {
      const [kind, a, b] = (line ?? "-").split(" ");
      if (kind === "d") return { kind: "dir", bytes: Number(a ?? 0) * 1024, mtimeMs: Number(b ?? 0) * 1000 };
      if (kind === "f") return { kind: "file", bytes: Number(a ?? 0), mtimeMs: Number(b ?? 0) * 1000 };
      return undefined;
    }),
  );
  const which = batched<boolean>(async items => (await answer("which", script.which, items)).map(line => line === "1"));
  const read = batched<string | undefined>(async items =>
    (await answer("read", script.read, items)).map((line, i) => {
      if (line === "!") refuse(`${items[i]} is over ${MACHINE_READ_CAP / 1024 / 1024} MB and was not read`);
      return line === undefined || line === "-" || line === "!" ? undefined : decoded(line);
    }),
  );
  const list = batched<string[]>(async items => (await answer("list", script.list, items)).map(line => (line === undefined ? [] : decoded(line).split("\n").filter(n => n !== "").sort())));
  const run = async (cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<string | undefined> => {
    const vars = Object.entries(opts.env ?? {});
    const line = [cmd, ...args].map(shellQuote).join(" ");
    const bound = { timeoutMs: Math.min(opts.timeoutMs ?? 120_000, EXEC_TIMEOUT_MAX_MS) };
    const pairs = Buffer.from(vars.map(([k, v]) => `${k}\0${v}\0`).join(""));
    if (vars.length === 0) return ok(await machine.exec(asLogin(login, `${line} </dev/null`), bound));
    if ("stdin" in envRoad) return ok(await machine.exec(asLogin(login, `${ENV_FROM_STDIN}${line} </dev/null`), { ...bound, stdin: pairs }));
    return ok(await stageAsLogin(machine, envRoad.land, login, "the command's variables", pairs, (file, folder) => machine.exec(asLogin(login, `${ENV_FROM_FILE} ${shellQuote(file)} ${shellQuote(folder)} ${line} </dev/null`), bound), { timeoutMs: STAGE_MS }));
  };
  const fs: HostFs = {
    stat,
    list,
    readText: read,
    walk: async dir => ((await run("find", [dir, "(", "-name", ".git", "-o", "-name", "node_modules", ")", "-prune", "-o", "-type", "f", "-print"])) ?? "").split("\n").filter(l => l !== "").sort(),
    async *lines(path) {
      const text = await read(path);
      if (text === undefined) return;
      yield* text.split("\n");
    },
  };
  const exec: HostExec = { which, run };
  return { platform: login.platform, home: login.home, fs, exec, refused };
}
