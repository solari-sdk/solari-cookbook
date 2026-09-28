// SPDX-License-Identifier: AGPL-3.0-only
// The rows an agent keeps in a store shared with every project cannot land as
// files without overwriting the machine's own, so a module emits a python3
// script the machine runs once its files have landed: nothing on the machine
// can run the engine, and python3 with its sqlite3 module is on the images.
import { PY_PREAMBLE, pyData } from "./py.js";

/** What the script prints as its last line: the rows it inserted or updated and the ones already as they should be,
 * with a note when a row was kept as the machine had it rather than as carried, or why it could not merge yet (the
 * agent has not made its store on the machine). */
export type MergeOutput = { merged: number; kept: number; note?: string } | { waiting: string };

/** The script's result off its stdout; anything else is an error naming what came back. */
export function parseMergeOutput(stdout: string): MergeOutput {
  const last = stdout.trimEnd().split("\n").at(-1) ?? "";
  if (last === "") throw new Error("the merge script printed nothing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw new Error(`the merge script ended with: ${last}`);
  }
  const o = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (typeof o["waiting"] === "string") return { waiting: o["waiting"] };
  if (typeof o["merged"] === "number" && typeof o["kept"] === "number") {
    return { merged: o["merged"], kept: o["kept"], ...(typeof o["note"] === "string" ? { note: o["note"] } : {}) };
  }
  throw new Error(`the merge script ended with: ${last}`);
}

/**
 * A merge script from its steps: the shared preamble, then FROM and TO, the path rule over them as moved(), out()
 * and fail() for the result, and write() for a file replaced in place; each step adds to merged and kept, and to
 * notes when it kept something as the machine had it, and the last line prints them. Text files are read and
 * written with surrogateescape so a line that is not UTF-8 passes through byte for byte.
 */
export function mergeScript(from: string, to: string, steps: readonly string[]): string {
  return [
    PY_PREAMBLE,
    "def moved(p):",
    "    return TO + p[len(FROM):] if under(p, FROM) else None",
    "def out(o):",
    "    print(json.dumps(o))",
    "    sys.exit(0)",
    "def fail(why):",
    "    print(why, file=sys.stderr)",
    "    sys.exit(1)",
    "def write(path, text):",
    '    tmp = path + ".wsp-merge"',
    '    with open(tmp, "w", encoding="utf-8", errors="surrogateescape", newline="") as f:',
    "        f.write(text)",
    "    if os.path.exists(path):",
    "        shutil.copymode(path, tmp)",
    "    os.replace(tmp, path)",
    `FROM = ${pyData(from)}`,
    `TO = ${pyData(to)}`,
    "merged = 0",
    "kept = 0",
    "notes = []",
    ...steps,
    'out({"merged": merged, "kept": kept, **({"note": "; ".join(notes)} if notes else {})})',
  ].join("\n");
}

/** A step rewriting `cwd` on every JSON line of the files that is FROM or a folder under it, inside the object
 * `holder` names on the line or the line itself; a file that is not there is passed over, one with nothing to
 * change is not written. */
export function jsonlCwdStep(files: readonly string[], holder?: string): string {
  return [
    `for f in ${pyData(files)}:`,
    "    if not os.path.exists(f):",
    "        continue",
    '    with open(f, encoding="utf-8", errors="surrogateescape", newline="") as h:',
    '        parts = h.read().split("\\n")',
    "    changed = False",
    "    for i, line in enumerate(parts):",
    "        try:",
    "            obj = json.loads(line)",
    "        except ValueError:",
    "            continue",
    "        if not isinstance(obj, dict):",
    "            continue",
    `        holder = ${holder === undefined ? "obj" : `obj.get(${pyData(holder)})`}`,
    "        if not isinstance(holder, dict):",
    "            continue",
    '        cwd = holder.get("cwd")',
    "        target = moved(cwd) if isinstance(cwd, str) else None",
    "        if target is None:",
    "            continue",
    '        holder["cwd"] = target',
    '        parts[i] = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))',
    "        changed = True",
    "    if changed:",
    '        write(f, "\\n".join(parts))',
  ].join("\n");
}
