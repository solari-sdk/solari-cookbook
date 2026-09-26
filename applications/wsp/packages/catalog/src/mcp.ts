// SPDX-License-Identifier: AGPL-3.0-only
// How an agent keeps its MCP servers: one module per config format, with
// what is done to such a file. The collector reads its servers, the install
// helper and the app's Add an MCP server place one, a person's Remove and Turn
// off take one out or flip its switch; the import edits the text it read off
// the machine, here, since a machine need carry no node of its own. An agent
// entry registers its format and its files. Pure text in and out: nothing here
// reads or writes a file.
import { findNodeAtLocation, parseTree, visit, type JSONPath, type Node } from "jsonc-parser";
import { readJsonc, type Jsonc } from "./jsonc.js";
import type { McpCheck } from "./mcp-check.js";
import type { McpLogin } from "./mcp-login.js";

export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { kind: "http"; url: string; headers: Record<string, string> };

export interface McpServer {
  name: string;
  /** `home`: Claude Code's project scope for the home folder itself, which the machine's home stands in for. */
  scope: "user" | "home";
  transport: McpTransport;
  /** Variables the definition reads from the environment at run time (Codex's bearer_token_env_var, a header's
   * reference in the format's own syntax); names only. */
  envRefs: string[];
  /** The file keeps the definition and switches it off: OpenCode's `enabled: false`, Codex's `enabled = false`. */
  disabled?: true;
}

export interface Placed {
  text: string;
}

/** What a remove came to: the file as it should stand, the text as it was where the file defines none of the names. */
export interface McpRemoved {
  text: string;
}

/** One config on the machine as its editor gets it: the kept and dropped server names, and for a format with
 * per-folder servers, the laptop folder whose servers now belong to the machine's home. */
export interface McpEditScope {
  keep: readonly string[];
  drop: readonly string[];
  project?: { from: string; to: string };
}

export interface McpEditResult {
  name: string;
  outcome: "written" | "missing" | "dropped";
  /** The kept server's command as the machine will run it. */
  command?: string;
}

/** One config on the machine as a merge gets it: the kept and dropped names as an edit has them, and the names
 * whose entry in the agent's own file is wsp's by the list beside the job, so it may be replaced or taken out.
 * Every other name in that file is the agent's own or the person's and stands. */
export interface McpMergeScope extends McpEditScope {
  replace: readonly string[];
}

export interface McpMergeResult {
  name: string;
  /** `added`: not in the agent's file, written from the copy that travelled; `replaced`: wsp's own entry, now the
   * travelled one; `same`: already the travelled entry; `theirs`: another entry under that name, left as it is;
   * `missing`: not in the copy that travelled; `dropped`: wsp's own entry taken out; `left`: a dropped name that is
   * not wsp's, untouched. */
  outcome: "added" | "replaced" | "same" | "theirs" | "missing" | "dropped" | "left";
  /** The written name's command as the machine will run it. */
  command?: string;
}

/** What a merge came to: the file as it should stand on the machine, the text as it was where nothing moved, and
 * empty where there is no file yet and nothing to put in one. */
export interface McpMerged {
  text: string;
  results: McpMergeResult[];
}

/** What every editor is handed besides the text. */
export interface McpEditLib {
  /** A kept definition's string as the machine reads it; `command` marks the program, a bare name when it sits in a bin directory. */
  rewriteString(s: string, command: boolean): string;
}

/** What an edit came to: the file as it should stand on the machine, the text unchanged where nothing moved. */
export interface McpEdited {
  text: string;
  results: McpEditResult[];
}

/** Edits one config file's text: kept servers' strings rewritten, dropped ones out, every other key and server
 * kept; reports each kept and dropped name. Throws when the text is not the format. */
export type McpEditor = (lib: McpEditLib, scope: McpEditScope, text: string) => McpEdited;

export interface McpFormat {
  /** Every server the text defines, in one shape; text that is not the format defines none. `home` is the folder
   * whose project-scoped servers count as the person's own. */
  read(text: string, home: string): McpServer[];
  /** The file's text with the server called `name` placed, or replaced when it is already there; `text` is
   * undefined when the file does not exist yet. Throws when the text is not the format. */
  place(text: string | undefined, name: string, server: McpTransport): Placed;
  /** The file's text with the server called `name` turned on or off by the switch the agent itself reads, every other
   * server as it was; absent on a format whose agent keeps no such switch per server. Throws when the text is not the
   * format or names no such server. */
  enable?(text: string, name: string, on: boolean, project?: string): Placed;
  /** The edit the import runs over the text it read off the machine. */
  edit: McpEditor;
  /** The definition one server has in a file of this format, in the one shape it keeps when the agent rewrites the
   * file: a JSON entry with its keys sorted at every depth, a TOML table's lines uncommented and trimmed. Whether a
   * key is wsp's own rests on this, so a field the agent adds to a table wsp wrote makes the entry read as the
   * agent's and never written over again. Nothing when the text names no server called that; `project` is the
   * folder whose own servers the name sits under, for a format that keeps servers per folder. */
  entryOf(text: string, name: string, project?: string): string | undefined;
  /** The agent's own file on the machine with wsp's servers merged into it: each kept name's definition taken from
   * the copy that travelled and put under this format's own key of `own`, every other key of `own` untouched.
   * `own` is undefined when the agent's file is not there yet, and the text is then empty when there was nothing to
   * put in one. Throws when either text is not the format. */
  merge(lib: McpEditLib, scope: McpMergeScope, own: string | undefined, travelled: string): McpMerged;
  /** The agent's own file with the named servers taken out from under this format's own key, every other key,
   * table, line and comment of theirs as it was; `project` is the folder whose own servers the names sit under, for
   * a format that keeps servers per folder. The text stands where it defines none of them. Throws when the text is
   * not the format. */
  remove(text: string, names: readonly string[], project?: string): McpRemoved;
  /** The text with every header and every command variable of its servers written as the name of a variable, in
   * the syntax this format's agent expands from its environment, and each value that left the text under the name
   * it now reads. A value that already names a variable stands as the person wrote it. `only` names one server of
   * the file's own table and leaves every other as it is. Throws when the text is not the format. */
  refer(text: string, only?: string): Promise<McpReferred>;
}

/** What a reference writer came to: the text, and per server the values it no longer holds, by variable name.
 * `project` is the folder whose own servers it sits under, for a format that keeps servers per folder. */
export interface McpReferred {
  text: string;
  servers: { name: string; project?: string; values: Record<string, string> }[];
  /** Every server definition the returned text holds, parsed. */
  entries: unknown[];
}

/** The variable a server's header travels under, since a header's name is not a variable's. */
export const mcpHeaderVariable = (server: string, header: string): string => `WSP_MCP_${server}_${header}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");

/** A value no variable can carry: an env file holds one variable per line. */
export const crossesLines = (value: string): boolean => /[\n\r]/.test(value);

/** Every string inside the given server definitions, at any depth. */
const stringsIn = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(stringsIn) : isObject(v) ? Object.values(v).flatMap(stringsIn) : []);

/** Refuses a copy whose server definitions still hold a value that was taken out of them, each side read whole and
 * with its scheme word (`Bearer`, `Basic`, `token`) taken off. Only the definitions are read, since
 * the values come from nowhere else, and the rest of an agent's file is prose and counters a value may match by chance. */
function stillStands(entries: readonly unknown[], servers: McpReferred["servers"]): void {
  const forms = (v: string): string[] => [v, ...(/^(?:bearer|basic|token)\s+(.+)$/i.exec(v)?.slice(1) ?? [])];
  const held = new Set(stringsIn(entries).flatMap(forms));
  for (const s of servers) {
    if (Object.values(s.values).some(v => forms(v).some(f => held.has(f)))) throw new Error(`${s.name}'s value still stands in the file after it was written by name, so the file stays on this computer`);
  }
}

/** Why a value typed or copied for a catalog row's own variable does not travel as a server's: `row` is that row. */
export const rowVariableLine = (name: string, row: string): string => `${name} belongs to the ${row} key, so set it there or give the variable another name`;

/** The minted names of one server's headers, refused where two headers would travel under one. */
function headerVariables(server: string, headers: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const h of headers) {
    const n = mcpHeaderVariable(server, h);
    const other = seen.get(n);
    if (other !== undefined) throw new Error(`${server} sends ${other} and ${h}, which would both travel as ${n}; rename one`);
    seen.set(n, h);
    out.set(h, n);
  }
  return out;
}

/** `Authorization: Bearer <token>`: the token alone, which is what both agents' by-name bearer fields read. */
const bearerToken = (header: string, value: string): string | undefined => (/^authorization$/i.test(header) ? /^Bearer\s+(\S.*)$/i.exec(value)?.[1] : undefined);

/** A file's servers written by name for a copy on another machine, `held` carrying the values an earlier file of the
 * same copy handed over. A server that would need a name to hold two values, or a value of more than one line, is
 * taken out of the text with the reason, and so is one that sets a variable a catalog row keeps its key under, which
 * `rowOf` names; a provider's key is never a server's value. */
export async function serversByName(format: McpFormat, text: string, held: Map<string, { value: string; by: string }>, rowOf: (name: string) => string | undefined): Promise<{ text: string; dropped: { name: string; reason: string }[] }> {
  const found = (await format.refer(text)).servers;
  const dropped: { name: string; reason: string; project?: string }[] = [];
  const kept = new Map<string, { value: string; by: string }>();
  for (const s of found) {
    const values = Object.entries(s.values);
    const owned = values.map(([name]) => [name, rowOf(name)] as const).find(([, row]) => row !== undefined);
    const clash = values.find(([name, value]) => {
      const at = held.get(name) ?? kept.get(name);
      return at !== undefined && at.value !== value;
    });
    const tall = values.find(([, value]) => crossesLines(value));
    if (owned !== undefined) dropped.push({ name: s.name, reason: rowVariableLine(owned[0], owned[1]!), ...(s.project !== undefined ? { project: s.project } : {}) });
    else if (clash !== undefined) dropped.push({ name: s.name, reason: `sets ${clash[0]}, which ${(held.get(clash[0]) ?? kept.get(clash[0]))!.by} already sets to another value`, ...(s.project !== undefined ? { project: s.project } : {}) });
    else if (tall !== undefined) dropped.push({ name: s.name, reason: `sets ${tall[0]} to a value on more than one line, which cannot travel by name`, ...(s.project !== undefined ? { project: s.project } : {}) });
    else for (const [name, value] of values) if (!held.has(name) && !kept.has(name)) kept.set(name, { value, by: s.name });
  }
  let out = text;
  for (const d of dropped) out = format.remove(out, [d.name], d.project).text;
  if (found.length === 0) return { text, dropped: [] };
  const final = await format.refer(out);
  stillStands(final.entries, found);
  const result = final.text;
  for (const [name, at] of kept) held.set(name, at);
  return { text: result, dropped: dropped.map(({ name, reason }) => ({ name, reason })) };
}

export interface McpConfig {
  format: McpFormat;
  /** `~/`-relative, each one of the entry's configPaths; the first that exists is the config. */
  files: readonly string[];
  /** The same agent's servers inside a project, project-relative; the first that exists is the project's. */
  projectFiles?: readonly string[];
  /** The scopes the file covers, shown on the wizard's group heading; every agent's docs also give a project scope
   * this file does not hold. */
  scope: string;
  /** Where an http server's sign-in lives when the agent keeps it beside its own login, for the row; absent, nothing is said. */
  httpAuth?: string;
  /** How the harness answers for one server's sign-in; absent where no harness's words were measured. */
  check?: McpCheck;
  /** How the harness signs one server in. */
  login?: McpLogin;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** A record written only where it holds something, so an entry with none keeps the shape it always had. */
const some = (key: string, d: Record<string, string>): Record<string, Record<string, string>> => (Object.keys(d).length === 0 ? {} : { [key]: d });
/** Each variable the header values name under the format's reference syntax, first seen first. */
const refsIn = (values: readonly string[], ref: RegExp): string[] => [...new Set(values.flatMap(v => [...v.matchAll(ref)].map(m => (m[1] ?? m[2])!)))];

function dict(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
}

// --- JSON formats ----------------------------------------------------------------------------------------------

function jsonObject(text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === "") return {};
  let read: Jsonc;
  try {
    read = readJsonc(text);
  } catch {
    throw new Error("the file is not valid JSON; add the server by hand");
  }
  if (!isObject(read.value)) throw new Error("the file is not a JSON object; add the server by hand");
  return read.value;
}

/** One change to a JSON file: the value at the path set, or taken out where it is undefined. */
export type JsonEdit = [JSONPath, unknown];

/** The same change made to the parsed value, a missing object on the way made as the in-place edit makes one; a
 * number at the end is an element of the array there, -1 one put after its last. */
function setAt(root: Tree, [path, value]: JsonEdit): void {
  // Own keys only, so a name such as __proto__ is a key as JSON.parse reads it and never the object's prototype.
  const put = (o: Tree, key: string, v: unknown): void => void Object.defineProperty(o, key, { value: v, enumerable: true, writable: true, configurable: true });
  const last = path[path.length - 1]!;
  const via = path.slice(0, -1).map(String);
  let at = root;
  for (const [i, key] of via.entries()) {
    const held = Object.hasOwn(at, key) ? at[key] : undefined;
    if (i === via.length - 1 && typeof last === "number" && Array.isArray(held)) {
      if (value === undefined) held.splice(last, 1);
      else if (last === -1) held.push(value);
      else held[last] = value;
      return;
    }
    if (tree(held) === undefined && !Array.isArray(held)) put(at, key, {});
    at = at[key] as Tree;
  }
  if (value === undefined) delete at[String(last)];
  else put(at, String(last), value);
}

interface Comment {
  at: number;
  end: number;
}

function commentsOf(text: string): Comment[] {
  const out: Comment[] = [];
  visit(text, { onComment: (at, length) => void out.push({ at, end: at + length }) }, { allowTrailingComma: true });
  return out;
}

/** How the text is laid out around its members, reading comments as the parser found them. */
function layout(text: string, comments: readonly Comment[]) {
  const lineStart = (p: number): number => text.lastIndexOf("\n", p - 1) + 1;
  const starts = new Map(comments.map(c => [c.at, c]));
  const commentAt = (p: number): Comment | undefined => starts.get(p);
  /** The first place at or after `p` that is neither white space nor a comment. */
  const past = (p: number): number => {
    for (;;) {
      while (p < text.length && /\s/.test(text[p]!)) p++;
      const c = commentAt(p);
      if (c === undefined) return p;
      p = c.end;
    }
  };
  /** Past the spaces, tabs and one-line comments that end the line from `p`, or -1 where anything else stands on it. */
  const lineRest = (p: number): number => {
    for (;;) {
      while (text[p] === " " || text[p] === "\t" || text[p] === "\r") p++;
      if (p >= text.length) return p;
      if (text[p] === "\n") return p + 1;
      const c = commentAt(p);
      if (c === undefined || text.slice(c.at, c.end).includes("\n")) return -1;
      p = c.end;
    }
  };
  const indent = (p: number): string => {
    const from = lineStart(p);
    let to = from;
    while (text[to] === " " || text[to] === "\t") to++;
    return text.slice(from, to);
  };
  return { lineStart, commentAt, past, lineRest, indent };
}

/** What taking out one member of an object or one element of an array cuts: its own text, from the comment lines
 * right above it (a blank line ends them) through the comma after it and the comment at the end of its line, with
 * the comma before it where it was the last; a member sharing its line with another is cut alone. `own` is the span
 * whose comments go with it. */
function memberCuts(text: string, kids: readonly Node[], i: number, comments: readonly Comment[]): { cuts: [number, number][]; own: [number, number] } {
  const { lineStart, commentAt, past, lineRest } = layout(text, comments);
  const unit = kids[i]!;
  const after = past(unit.offset + unit.length);
  const comma = text[after] === "," ? after : -1;
  const end = comma >= 0 ? comma + 1 : unit.offset + unit.length;
  const cuts: [number, number][] = [];
  if (comma < 0 && i > 0) {
    const before = past(kids[i - 1]!.offset + kids[i - 1]!.length);
    if (text[before] === ",") cuts.push([before, before + 1]);
  }
  const rest = lineRest(end);
  if (text.slice(lineStart(unit.offset), unit.offset).trim() !== "" || rest < 0) {
    let to = end;
    while (comma >= 0 && (text[to] === " " || text[to] === "\t")) to++;
    cuts.push([unit.offset, to]);
    return { cuts, own: [unit.offset, to] };
  }
  let from = lineStart(unit.offset);
  while (from > 0) {
    const above = lineStart(from - 1);
    let first = above;
    while (text[first] === " " || text[first] === "\t") first++;
    if (commentAt(first) === undefined || lineRest(above) !== from) break;
    from = above;
  }
  cuts.push([from, rest]);
  return { cuts, own: [from, rest] };
}

/** A value as it is put into the text: on lines of its own under `indent` in a file laid out on lines, else on one. */
const rendered = (value: unknown, indent: string | undefined, eol: string): string =>
  indent === undefined ? JSON.stringify(value) : JSON.stringify(value, null, 2).replace(/\n/g, `${eol}${indent}`);

/** The text with `entry` put into `container` after its last member: on a line of its own under that member where it
 * ends its line, so the comment at the end of that line stays that member's; beside it where the container sits on
 * one line; on the line after the opening bracket of an empty one laid out on lines. */
function inserted(text: string, container: Node, entry: (indent: string | undefined) => string, comments: readonly Comment[]): string {
  const { past, lineRest, indent } = layout(text, comments);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const kids = container.children ?? [];
  const at = (p: number, put: string): string => text.slice(0, p) + put + text.slice(p);
  if (kids.length === 0) {
    const open = container.offset + 1;
    const rest = lineRest(open);
    if (rest < 0 || text[rest - 1] !== "\n") return at(open, entry(undefined));
    const inner = `${indent(container.offset)}  `;
    return at(rest, `${inner}${entry(inner)}${eol}`);
  }
  const last = kids[kids.length - 1]!;
  const end = last.offset + last.length;
  const after = past(end);
  const trailing = text[after] === ",";
  const rest = lineRest(trailing ? after + 1 : end);
  if (rest < 0 || text[rest - 1] !== "\n") return trailing ? at(after + 1, ` ${entry(undefined)},`) : at(end, `, ${entry(undefined)}`);
  const inner = indent(last.offset);
  const line = `${inner}${entry(inner)}${trailing ? "," : ""}${eol}`;
  return trailing ? at(rest, line) : `${text.slice(0, end)},${text.slice(end, rest)}${line}${text.slice(rest)}`;
}

const LOST_COMMENT = "the change would lose a comment that is not the server's, so it was not made; change the file by hand";

/** One edit made to the text: a member or element taken out by its own span, a value put in where it stood, or put
 * into the deepest object or array on its path that is there. Every comment outside what the edit takes out must stand
 * after it, or the edit is refused. */
function editOnce(text: string, [path, value]: JsonEdit): string {
  const comments = commentsOf(text);
  const doc = parseTree(text, [], { allowTrailingComma: true });
  if (doc === undefined) throw new Error("the file is not JSON");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let depth = path.length;
  while (depth > 0 && findNodeAtLocation(doc, path.slice(0, depth)) === undefined) depth--;
  const node = findNodeAtLocation(doc, path.slice(0, depth)) ?? doc;
  let out: string;
  let own: [number, number] = [0, 0];
  if (value === undefined) {
    if (depth < path.length) return text;
    const unit = node.parent?.type === "property" ? node.parent : node;
    const kids = unit.parent?.children ?? [];
    const cut = memberCuts(text, kids, kids.indexOf(unit), comments);
    own = cut.own;
    out = text;
    for (const [from, to] of [...cut.cuts].sort((x, y) => y[0] - x[0])) out = out.slice(0, from) + out.slice(to);
  } else {
    const wrap = (from: number): unknown => path.slice(from).reduceRight<unknown>((v, k) => (typeof k === "number" ? [v] : { [k]: v }), value);
    const wrapped = wrap(depth + 1);
    const key = path[depth];
    if (node.type === "object" && typeof key === "string") {
      out = inserted(text, node, indent => `${JSON.stringify(key)}: ${rendered(wrapped, indent, eol)}`, comments);
    } else if (node.type === "array" && key === -1) {
      out = inserted(text, node, indent => rendered(wrapped, indent, eol), comments);
    } else {
      own = [node.offset, node.offset + node.length];
      const lined = text.slice(node.offset, node.offset + node.length).includes("\n");
      out = text.slice(0, node.offset) + rendered(wrap(depth), lined ? layout(text, comments).indent(node.offset) : undefined, eol) + text.slice(node.offset + node.length);
    }
  }
  keepsComments(text, comments, out, own);
  return out;
}

/** Refuses an edit after which a comment outside `own`, the span it took out, no longer stands. */
function keepsComments(text: string, comments: readonly Comment[], out: string, own: [number, number]): void {
  const kept = comments.filter(c => c.at < own[0] || c.end > own[1]).map(c => text.slice(c.at, c.end));
  const left = commentsOf(out).map(c => out.slice(c.at, c.end));
  if (kept.length !== left.length || kept.some((c, i) => c !== left[i])) throw new Error(LOST_COMMENT);
}

/** Several keys an object does not hold put into it with one parse of the text, in the order given; an object the
 * text does not hold yet is made whole as editOnce makes one. */
function insertMany(text: string, at: JSONPath, members: readonly [string, unknown][]): string {
  const doc = parseTree(text, [], { allowTrailingComma: true });
  if (doc === undefined) throw new Error("the file is not JSON");
  const node = findNodeAtLocation(doc, at);
  if (node === undefined) return editOnce(text, [at, Object.fromEntries(members)]);
  const comments = commentsOf(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const entry = (indent: string | undefined): string => members.map(([key, value]) => `${JSON.stringify(key)}: ${rendered(value, indent, eol)}`).join(indent === undefined ? ", " : `,${eol}${indent}`);
  const out = inserted(text, node, entry, comments);
  keepsComments(text, comments, out, [0, 0]);
  return out;
}

/** The edits from `from` on that each put a new key into one same object, which insertMany makes in one parse: a
 * merge of many servers into a file of megabytes would otherwise parse it once per server. */
function newKeys(root: Tree, edits: readonly JsonEdit[], from: number): JsonEdit[] {
  const parent = edits[from]![0].slice(0, -1);
  const run: JsonEdit[] = [];
  for (const edit of edits.slice(from)) {
    const [path, value] = edit;
    const key = path[path.length - 1];
    if (value === undefined || typeof key !== "string" || path.length !== parent.length + 1 || parent.some((k, i) => k !== path[i])) break;
    const holder = parent.reduce<unknown>((v, k) => (tree(v) !== undefined && Object.hasOwn(v as Tree, String(k)) ? (v as Tree)[String(k)] : undefined), root);
    if ((holder !== undefined && (tree(holder) === undefined || Object.hasOwn(holder as Tree, key))) || run.some(([p]) => p[p.length - 1] === key)) break;
    run.push(edit);
  }
  return run;
}

/** The file's text with the edits made in place, so every comment and every byte they do not touch stays where it
 * was; `root` is the text parsed. An edit whose result would read as anything but the edits made to that value is
 * refused, since a file with a key twice or a shape the in-place edit cannot follow is not written as a guess. */
function editJsonc(text: string, root: Tree, edits: readonly JsonEdit[]): string {
  let out = text;
  let same = false;
  try {
    for (let i = 0; i < edits.length; ) {
      const run = newKeys(root, edits, i);
      const step = run.length > 1 ? run : [edits[i]!];
      out = run.length > 1 ? insertMany(out, run[0]![0].slice(0, -1), run.map(([path, value]) => [String(path[path.length - 1]), value])) : editOnce(out, step[0]!);
      for (const edit of step) setAt(root, edit);
      i += step.length;
    }
    same = jsonCanonical(readJsonc(out).value) === jsonCanonical(root);
  } catch (e) {
    if (e instanceof Error && e.message === LOST_COMMENT) throw e;
  }
  if (!same) throw new Error("the file could not be changed in place, which keeps its comments; change it by hand");
  return out;
}

/** A config's JSON or jsonc text with the edits made in place, every comment and byte they do not touch where it
 * was: the one editor every road that changes an agent's JSON config goes through. Throws when the text is not a
 * JSON object or the edits cannot be made in place. */
export function editJson(text: string, edits: readonly JsonEdit[]): string {
  const root = tree(readJsonc(text).value);
  if (root === undefined) throw new Error("the file is not a JSON object");
  return editJsonc(text, root, edits);
}

/** The servers under `key` of a JSON object, each read by the format's own entry shape. */
function jsonServers(root: Record<string, unknown>, key: string, scope: McpServer["scope"], server: JsonShape["server"]): McpServer[] {
  const table = root[key];
  if (!isObject(table)) return [];
  return Object.entries(table).flatMap(([name, raw]) => {
    const s = server(name, raw, scope);
    return s === undefined ? [] : [s];
  });
}

type Tree = Record<string, unknown>;
const tree = (v: unknown): Tree | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Tree) : undefined);

/** Every string of a definition as the machine reads it: the value under `command` and the first word of a command
 * array are the program, everything else a plain string. */
const walkStrings = (lib: McpEditLib, v: unknown, command: boolean): unknown => {
  if (typeof v === "string") return lib.rewriteString(v, command);
  if (Array.isArray(v)) return v.map((x, i) => walkStrings(lib, x, command && i === 0));
  const o = tree(v);
  return o === undefined ? v : Object.fromEntries(Object.keys(o).map(k => [k, walkStrings(lib, o[k], k === "command")]));
};

/** The program a JSON definition names, as a string or as the first word of its command array. */
const jsonCommandOf = (def: unknown): string | undefined => {
  const c = tree(def)?.command;
  return typeof c === "string" ? c : Array.isArray(c) && typeof c[0] === "string" ? c[0] : undefined;
};

/** A JSON value in the one shape it keeps when the agent rewrites the file: every object's keys in sorted order at
 * every depth, so an entry written back with its keys another way round still reads as the same entry. */
function jsonCanonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonCanonical).join(",")}]`;
  const o = tree(v);
  return o === undefined ? (JSON.stringify(v) ?? "null") : `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${jsonCanonical(o[k])}`).join(",")}}`;
}

/** The merge for a JSON file with its servers under `key`: wsp's keys put into the agent's own file in place, and
 * not one other key or comment of theirs read or moved. Per-folder servers go under `projects.<folder>.<key>` as
 * the editor puts them, and the folder the definitions travelled from is not made. */
function jsonMerger(key: string): McpFormat["merge"] {
  return (lib, scope, own, travelled) => {
    const held = own === undefined || own.trim() === "" ? undefined : own;
    const root = tree(held === undefined ? {} : readJsonc(held).value);
    if (root === undefined) throw new Error("the file is not a JSON object");
    const from = tree(readJsonc(travelled).value);
    if (from === undefined) throw new Error("the copy that travelled is not a JSON object");
    const project = scope.project;
    const source = project === undefined ? from : tree(tree(from.projects)?.[project.from]) ?? {};
    const arrived = tree(source[key]) ?? {};
    const at: JSONPath = project === undefined ? [key] : ["projects", project.to, key];
    const standing = project === undefined ? tree(root[key]) ?? {} : tree(tree(tree(root.projects)?.[project.to])?.[key]) ?? {};
    const replace = new Set(scope.replace);
    const results: McpMergeResult[] = [];
    const edits: JsonEdit[] = [];
    for (const name of scope.keep) {
      const def = arrived[name];
      if (def === undefined) {
        results.push({ name, outcome: "missing" });
        continue;
      }
      const next = walkStrings(lib, def, false);
      const said = (outcome: McpMergeResult["outcome"]): void => void results.push({ name, outcome, command: jsonCommandOf(next) });
      const here = standing[name];
      if (here !== undefined && jsonCanonical(here) === jsonCanonical(next)) said("same");
      else if (here !== undefined && !replace.has(name)) said("theirs");
      else {
        edits.push([[...at, name], next]);
        said(here === undefined ? "added" : "replaced");
      }
    }
    for (const name of scope.drop) {
      if (standing[name] === undefined || !replace.has(name)) {
        results.push({ name, outcome: "left" });
        continue;
      }
      edits.push([[...at, name], undefined]);
      results.push({ name, outcome: "dropped" });
    }
    if (edits.length === 0) return { text: own ?? "", results };
    if (held !== undefined) return { text: editJsonc(held, root, edits), results };
    for (const edit of edits) setAt(root, edit);
    return { text: `${JSON.stringify(root, null, 2)}\n`, results };
  };
}

/** The remove for a JSON file with its servers under `key`: the named keys taken out of the table they sit in, in
 * place, and every other key and comment of theirs where it was. The table itself stays, empty or not: it is the
 * agent's own key, not wsp's to take. */
function jsonRemover(shape: JsonShape): McpFormat["remove"] {
  const key = shape.key;
  return (text, names, project) => {
    const root = tree(readJsonc(text).value);
    if (root === undefined) throw new Error("the file is not a JSON object");
    const at: JSONPath = project === undefined ? [key] : ["projects", project, key];
    const table = project === undefined ? tree(root[key]) : tree(tree(tree(root.projects)?.[project])?.[key]);
    if (table === undefined) return { text };
    const took = names.filter(name => Object.hasOwn(table, name));
    if (took.length === 0) return { text };
    let out = editJsonc(text, root, took.map((name): JsonEdit => [[...at, name], undefined]));
    // A name the file switches off outside its entry is switched back on as the entry goes, so it goes whole.
    for (const name of took) if (shape.flip !== undefined && (shape.off?.(root) ?? []).includes(name)) out = editJsonc(out, root, shape.flip(root, [...at, name], name, true));
    return { text: out };
  };
}

/** Each string of a definition the machine reads another way, as an edit at its own path, so every comment inside
 * the definition stands. */
const stringEdits = (lib: McpEditLib, v: unknown, path: JSONPath, command: boolean): JsonEdit[] => {
  if (typeof v === "string") {
    const next = lib.rewriteString(v, command);
    return next === v ? [] : [[path, next]];
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => stringEdits(lib, x, [...path, i], command && i === 0));
  const o = tree(v);
  return o === undefined ? [] : Object.keys(o).flatMap(k => stringEdits(lib, o[k], [...path, k], k === "command"));
};

/** The editor for a JSON file with its servers under `key`, and per-folder servers under
 * `projects.<folder>.<key>` when the scope names a folder: edited in place, every comment outside what moves kept. */
function jsonEditor(key: string): McpEditor {
  return (lib, scope, before) => {
    const root = tree(readJsonc(before).value);
    if (root === undefined) throw new Error("the file is not a JSON object");
    const project = scope.project;
    const src: JSONPath = project === undefined ? [key] : ["projects", project.from, key];
    const dst: JSONPath = project === undefined ? [key] : ["projects", project.to, key];
    const servers = (project === undefined ? tree(root[key]) : tree(tree(tree(root.projects)?.[project.from])?.[key])) ?? {};
    const moved = project === undefined ? {} : tree(tree(tree(root.projects)?.[project.to])?.[key]) ?? {};
    const results: McpEditResult[] = [];
    const edits: JsonEdit[] = [];
    for (const name of scope.keep) {
      const def = servers[name];
      if (def === undefined) {
        results.push(moved[name] !== undefined ? { name, outcome: "written", command: jsonCommandOf(moved[name]) } : { name, outcome: "missing" });
        continue;
      }
      const next = walkStrings(lib, def, false);
      if (project === undefined) edits.push(...stringEdits(lib, def, [...src, name], false));
      else edits.push([[...src, name], undefined], [[...dst, name], next]);
      results.push({ name, outcome: "written", command: jsonCommandOf(next) });
    }
    for (const name of scope.drop) {
      if (Object.hasOwn(servers, name)) edits.push([[...src, name], undefined]);
      results.push({ name, outcome: "dropped" });
    }
    return { text: edits.length === 0 ? before : editJsonc(before, root, edits), results };
  };
}

interface JsonShape {
  /** The root key the servers sit under. */
  key: string;
  /** The format's own entry as one server, or nothing when it names neither a command nor a url. */
  server(name: string, raw: unknown, scope: McpServer["scope"]): McpServer | undefined;
  /** The entry the format writes for a placed server. */
  entry(server: McpTransport): unknown;
  /** The file also holds per-folder servers under `projects.<folder>.<key>`; the home folder's are read as its own. */
  projects: boolean;
  /** The names the file switches off outside their entries, as Gemini CLI's `mcp.excluded`. */
  off?(root: Record<string, unknown>): string[];
  /** The edits that turn the entry at `entry` on or off by the switch the agent reads, in the order they are made;
   * absent where it keeps none. */
  flip?(root: Tree, entry: JSONPath, name: string, on: boolean): JsonEdit[];
  /** The key an entry's command variables sit under. */
  envKey: string;
  /** A variable named anywhere in a string, in the syntax this format's agent expands. */
  ref: RegExp;
  /** A variable written in that syntax. */
  refOf(variable: string): string;
}

/** The reference writer for a JSON file: each server's header and command variable values put in place by name,
 * every other key and comment where it was. */
function jsonReferrer(shape: JsonShape): McpFormat["refer"] {
  /** The file's own server table, and with `folders` each folder's under `projects`, for a format that keeps them. */
  const serverTables = (root: Tree, folders: boolean): { at: JSONPath; project?: string; servers: Tree }[] => [
    { at: [shape.key], servers: tree(root[shape.key]) ?? {} },
    ...(shape.projects && folders
      ? Object.entries(tree(root.projects) ?? {}).flatMap(([folder, held]) => {
          const servers = tree(tree(held)?.[shape.key]);
          return servers === undefined ? [] : [{ at: ["projects", folder, shape.key] as JSONPath, project: folder, servers }];
        })
      : []),
  ];
  const names = (v: string): boolean => new RegExp(shape.ref.source).test(v);
  /** A value that is one reference and nothing else, a bearer's included. */
  const whole = (v: string): boolean => new RegExp(`^(?:Bearer\\s+)?(?:${shape.ref.source})$`, "i").test(v);
  return async (text, only) => {
    const root = jsonObject(text);
    const tables = serverTables(root, only === undefined);
    const edits: JsonEdit[] = [];
    const servers: McpReferred["servers"] = [];
    for (const table of tables) {
      for (const [name, raw] of Object.entries(table.servers)) {
        const def = tree(raw);
        if (def === undefined || (only !== undefined && name !== only)) continue;
        const values: Record<string, string> = {};
        const put = (key: string, entries: Record<string, string>, variable: (k: string) => string, bearer: boolean): void => {
          for (const [k, v] of Object.entries(entries)) {
            if (v === "" || whole(v)) continue;
            if (names(v)) throw new Error(`${name}'s ${k} mixes a value with a variable, so it cannot travel by name; make it one or the other`);
            const n = variable(k);
            const token = bearer ? bearerToken(k, v) : undefined;
            values[n] = token ?? v;
            edits.push([[...table.at, name, key, k], token !== undefined ? `Bearer ${shape.refOf(n)}` : shape.refOf(n)]);
          }
        };
        const minted = headerVariables(name, Object.keys(dict(def.headers)));
        put("headers", dict(def.headers), h => minted.get(h)!, true);
        put(shape.envKey, dict(def[shape.envKey]), k => k, false);
        servers.push({ name, ...(table.project !== undefined ? { project: table.project } : {}), values });
      }
    }
    const out = edits.length === 0 ? text : editJsonc(text, root, edits);
    const entries = serverTables(jsonObject(out), true).flatMap(t => Object.values(t.servers));
    stillStands(entries, servers);
    return { text: out, servers, entries };
  };
}

function jsonFormat(shape: JsonShape): McpFormat {
  return {
    read: (text, home) => {
      let root: unknown;
      try {
        root = readJsonc(text).value;
      } catch {
        return [];
      }
      if (!isObject(root)) return [];
      const off = new Set(shape.off?.(root) ?? []);
      const own = jsonServers(root, shape.key, "user", shape.server).map(s => (off.has(s.name) ? { ...s, disabled: true as const } : s));
      const project = shape.projects && isObject(root.projects) ? root.projects[home] : undefined;
      return isObject(project) ? [...own, ...jsonServers(project, shape.key, "home", shape.server)] : own;
    },
    place: (text, name, server) => {
      const root = jsonObject(text);
      const entry = shape.entry(server);
      if (text === undefined || text.trim() === "") return { text: `${JSON.stringify({ [shape.key]: { [name]: entry } }, null, 2)}\n` };
      return { text: editJsonc(text, root, [isObject(root[shape.key]) ? [[shape.key, name], entry] : [[shape.key], { [name]: entry }]]) };
    },
    edit: jsonEditor(shape.key),
    entryOf: (text, name, project) => {
      let held: unknown;
      try {
        held = readJsonc(text).value;
      } catch {
        return undefined;
      }
      const root = tree(held);
      const source = root === undefined ? undefined : project === undefined ? root : tree(tree(root.projects)?.[project]);
      const def = source === undefined ? undefined : tree(source[shape.key])?.[name];
      return def === undefined ? undefined : jsonCanonical(def);
    },
    merge: jsonMerger(shape.key),
    remove: jsonRemover(shape),
    refer: jsonReferrer(shape),
    ...(shape.flip === undefined ? {} : { enable: jsonEnabler(shape.key, shape.flip) }),
  };
}

/** The switch for a JSON file: the named entry found under `key` (a folder's own under `projects.<folder>`), flipped
 * in place. */
function jsonEnabler(key: string, flip: NonNullable<JsonShape["flip"]>): NonNullable<McpFormat["enable"]> {
  return (text, name, on, project) => {
    const root = jsonObject(text);
    const source = project === undefined ? root : tree(tree(root.projects)?.[project]);
    if (tree(tree(source?.[key])?.[name]) === undefined) throw new Error(`the file names no server called ${name}`);
    const at: JSONPath = project === undefined ? [key, name] : ["projects", project, key, name];
    return { text: editJsonc(text, root, flip(root, at, name, on)) };
  };
}

/** `mcpServers.<name> = { command, args, env, cwd }` or `{ url | httpUrl, headers }`, whose url and headers take
 * `ref`'s variables from the environment; an address is written as `remote` writes its key. */
const mcpServersJson = (ref: RegExp, remote: (url: string) => Record<string, string>, extra: Pick<JsonShape, "off" | "flip"> = {}): McpFormat =>
  jsonFormat({
    ...extra,
    key: "mcpServers",
    projects: true,
    envKey: "env",
    ref,
    refOf: v => `\${${v}}`,
    server: (name, raw, scope) => {
      if (!isObject(raw)) return undefined;
      const command = str(raw.command);
      const url = str(raw.httpUrl) ?? str(raw.url);
      if (command !== undefined) {
        const cwd = str(raw.cwd);
        return { name, scope, transport: { kind: "stdio", command, args: strs(raw.args), env: dict(raw.env), ...(cwd !== undefined ? { cwd } : {}) }, envRefs: [] };
      }
      if (url !== undefined) {
        const headers = dict(raw.headers);
        return { name, scope, transport: { kind: "http", url, headers }, envRefs: refsIn([url, ...Object.values(headers)], ref) };
      }
      return undefined;
    },
    entry: s => (s.kind === "stdio" ? { command: s.command, args: [...s.args], ...some("env", s.env) } : { ...remote(s.url), ...some("headers", s.headers) }),
  });

/** Claude Code's user file, whose `projects` hold the same shape per folder: `${X}` and `${X:-default}`. Its only
 * switch is per folder in its own /mcp, so no server is turned off here. */
export const MCP_SERVERS_JSON: McpFormat = mcpServersJson(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g, url => ({ type: "http", url }));

/** Gemini CLI's settings, which also expand a bare `$X`, take a streamable address as `httpUrl`, and switch a server
 * off by its name in `mcp.excluded`. */
export const GEMINI_SETTINGS_JSON: McpFormat = mcpServersJson(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g, url => ({ httpUrl: url }), {
  off: root => strs(tree(root.mcp)?.excluded),
  flip: (root, _entry, name, on) => {
    const held = tree(root.mcp)?.excluded;
    if (!Array.isArray(held)) return on ? [] : [[["mcp", "excluded"], [name]]];
    if (!on) return [[["mcp", "excluded", -1], name]];
    return held.flatMap((n, i): JsonEdit[] => (n === name ? [[["mcp", "excluded", i], undefined]] : [])).reverse();
  },
});

const OPENCODE_REF = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** `mcp.<name> = { type: "local", command: [command, ...args], environment }` or `{ type: "remote", url, headers }`:
 * OpenCode's config. */
export const OPENCODE_JSON: McpFormat = jsonFormat({
  key: "mcp",
  projects: false,
  envKey: "environment",
  ref: OPENCODE_REF,
  refOf: v => `{env:${v}}`,
  server: (name, raw, scope) => {
    if (!isObject(raw)) return undefined;
    const off = raw.enabled === false ? { disabled: true as const } : {};
    if (raw.type === "remote") {
      const url = str(raw.url);
      const headers = dict(raw.headers);
      return url === undefined ? undefined : { name, scope, transport: { kind: "http", url, headers }, envRefs: refsIn(Object.values(headers), OPENCODE_REF), ...off };
    }
    const [command, ...args] = strs(raw.command);
    if (command === undefined) return undefined;
    return { name, scope, transport: { kind: "stdio", command, args, env: dict(raw.environment) }, envRefs: [], ...off };
  },
  entry: s => (s.kind === "stdio" ? { type: "local", command: [s.command, ...s.args], enabled: true, ...some("environment", s.env) } : { type: "remote", url: s.url, enabled: true, ...some("headers", s.headers) }),
  flip: (_root, entry, _name, on) => [[[...entry, "enabled"], on]],
});

// --- Codex's TOML ------------------------------------------------------------------------------------------------
// Only the table form Codex documents and `codex mcp add` writes is read or edited, line by line, so comments and
// order survive. The functions the machine's editor calls are written once here and travel as their own source, so
// each one may only name declarations of this module: an import would reach for a binding the machine never got.

/** A line without its trailing comment: `#` outside quotes ends it. */
export function uncommentToml(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== undefined) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** `[mcp_servers.<name>]` or `[mcp_servers.<name>.<sub>]`, the name bare or quoted; nothing for any other header. */
function tomlHeader(line: string): { name: string; sub?: string } | undefined {
  const m = /^\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(?:\.\s*([A-Za-z0-9_-]+)\s*)?\]$/.exec(line);
  if (m === null) return undefined;
  return { name: (m[1] ?? m[2] ?? m[3])!, ...(m[4] !== undefined ? { sub: m[4] } : {}) };
}

/** A basic string with its escapes, or a literal one: group 1 or group 2. */
function tomlStringPattern(): RegExp {
  return /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
}

function tomlEscapes(): Record<string, string> {
  return { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
}

function decodeToml(s: string): string {
  const escapes = tomlEscapes();
  return s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (m, e: string) => (e[0] === "u" || e[0] === "U" ? String.fromCodePoint(parseInt(e.slice(1), 16)) : (escapes[e] ?? m)));
}

function encodeToml(s: string): string {
  const escapes = tomlEscapes();
  return s.replace(/[\\"\u0000-\u001f\u007f]/g, c => {
    const back = Object.keys(escapes).find(k => escapes[k] === c);
    return back !== undefined ? `\\${back}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/** Every string in the text, decoded. */
export function tomlStrings(s: string): string[] {
  return [...s.matchAll(tomlStringPattern())].map(m => (m[1] !== undefined ? decodeToml(m[1]) : m[2]!));
}

/** Whether a value read so far is an array that closes on a later line. */
export function tomlOpenArray(value: string): boolean {
  return value.startsWith("[") && !value.endsWith("]");
}

/** A string, an array of strings, or an inline table of strings; anything else is left out. */
function tomlValue(raw: string): unknown {
  const s = raw.trim();
  if (s.startsWith("[")) return tomlStrings(s);
  if (s.startsWith("{")) {
    const out: Record<string, string> = {};
    for (const m of s.slice(1, -1).matchAll(/(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) {
      out[m[1] ?? m[2] ?? m[3]!] = tomlStrings(m[4]!)[0] ?? "";
    }
    return out;
  }
  if (s.startsWith('"') || s.startsWith("'")) return tomlStrings(s)[0];
  return undefined;
}

interface CodexTable {
  values: Record<string, unknown>;
  disabled?: true;
  env: Record<string, string>;
  headers: Record<string, string>;
  envHeaders: Record<string, string>;
}

/** Codex's `[mcp_servers.<name>]` tables and their env, http_headers and env_http_headers sub-tables, in file order. */
function readCodex(text: string): McpServer[] {
  const tables = new Map<string, CodexTable>();
  let current: { name: string; sub?: string } | undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = uncommentToml(lines[i]!).trim();
    if (line === "") continue;
    if (line.startsWith("[")) {
      current = tomlHeader(line);
      if (current !== undefined && !tables.has(current.name)) tables.set(current.name, { values: {}, env: {}, headers: {}, envHeaders: {} });
      continue;
    }
    if (current === undefined) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"(.*)"$/, "$1");
    let value = line.slice(eq + 1).trim();
    while (tomlOpenArray(value) && i + 1 < lines.length) value += uncommentToml(lines[++i]!).trim();
    if (current.sub === undefined && key === "enabled" && value === "false") tables.get(current.name)!.disabled = true;
    const parsed = tomlValue(value);
    if (parsed === undefined) continue;
    const table = tables.get(current.name)!;
    if (current.sub === undefined) table.values[key] = parsed;
    else if (typeof parsed === "string") {
      if (current.sub === "env") table.env[key] = parsed;
      else if (current.sub === "http_headers") table.headers[key] = parsed;
      else if (current.sub === "env_http_headers") table.envHeaders[key] = parsed;
    }
  }
  const out: McpServer[] = [];
  for (const [name, t] of tables) {
    const command = str(t.values.command);
    const url = str(t.values.url);
    const bearer = str(t.values.bearer_token_env_var);
    const envRefs = [...(bearer !== undefined ? [bearer] : []), ...Object.values({ ...dict(t.values.env_http_headers), ...t.envHeaders })];
    const off = t.disabled === true ? { disabled: true as const } : {};
    if (command !== undefined) {
      out.push({ name, scope: "user", transport: { kind: "stdio", command, args: strs(t.values.args), env: { ...dict(t.values.env), ...t.env } }, envRefs, ...off });
    } else if (url !== undefined) {
      out.push({ name, scope: "user", transport: { kind: "http", url, headers: { ...dict(t.values.http_headers), ...t.headers } }, envRefs, ...off });
    }
  }
  return out;
}

// A JSON string is a valid TOML basic string: the same escapes for quote, backslash and control characters.
const tomlString = (s: string): string => JSON.stringify(s);

/** An inline table of strings, every key and value quoted. */
const tomlInline = (d: Record<string, string>): string => `{ ${Object.entries(d).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(", ")} }`;

/** The lines of a server's own table under its header: a command with its args and variables, or an address with its
 * headers. */
function codexLines(server: McpTransport): string[] {
  if (server.kind === "http") return [`url = ${tomlString(server.url)}`, ...(Object.keys(server.headers).length === 0 ? [] : [`http_headers = ${tomlInline(server.headers)}`])];
  return [`command = ${tomlString(server.command)}`, `args = [${server.args.map(tomlString).join(", ")}]`, ...(Object.keys(server.env).length === 0 ? [] : [`env = ${tomlInline(server.env)}`])];
}

/** `[mcp_servers.<name>]` with its lines. The table is replaced in place when it is there (up to the next table
 * header), appended after a blank line when it is not; every other line stays as written. */
function placeCodex(text: string | undefined, name: string, server: McpTransport): string {
  const header = `[mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name)}]`;
  const table = `${[header, ...codexLines(server)].join("\n")}\n`;
  if (text === undefined || text.trim() === "") return table;
  const lines = text.split("\n");
  const start = lines.findIndex(l => l.trim() === header);
  if (start === -1) return `${text.endsWith("\n") ? text : `${text}\n`}\n${table}`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  // Blank lines before the next header stay with the table that follows, so the replaced block keeps one.
  const gap = end < lines.length ? [""] : [];
  return [...lines.slice(0, start), ...table.slice(0, -1).split("\n"), ...gap, ...lines.slice(end)].join("\n");
}

/** A line with every string on it put through `to`, decoded and re-encoded only where the value changed, so escapes
 * the rewrite never touched stay as written and the trailing comment is left alone. */
export function rewriteTomlLine(line: string, to: (value: string) => string): string {
  const code = uncommentToml(line);
  const next = code.replace(tomlStringPattern(), (m: string, basic: string | undefined, literal: string | undefined) => {
    if (literal !== undefined) {
      const value = to(literal);
      return value === literal ? m : `'${value}'`;
    }
    const value = decodeToml(basic!);
    const rewritten = to(value);
    return rewritten === value ? m : `"${encodeToml(rewritten)}"`;
  });
  return next + line.slice(code.length);
}

/** Which server each line of the text belongs to: the name of the last `[mcp_servers.<name>]` header, that table's
 * sub-tables and the blank lines under them included; nothing for a line before any of them or under another
 * table. */
function codexOwners(lines: readonly string[]): (string | undefined)[] {
  const owner: (string | undefined)[] = [];
  let current: string | undefined;
  for (const raw of lines) {
    const t = uncommentToml(raw).trim();
    if (t.startsWith("[")) current = tomlHeader(t)?.name;
    owner.push(current);
  }
  return owner;
}

/** Where one server's tables sit in the text, in file order. `trim` leaves the blank lines at their end out, which
 * is what keeps the gap in front of whatever follows when the block is written over. */
function codexBlock(lines: readonly string[], name: string, trim: boolean): number[] {
  const owner = codexOwners(lines);
  const at = lines.flatMap((_, i) => (owner[i] === name ? [i] : []));
  if (trim) while (at.length > 0 && lines[at[at.length - 1]!]!.trim() === "") at.pop();
  return at;
}

/** One server's tables in the one shape they keep when Codex writes the file again: every line without its comment
 * and its spacing, the blank ones left out. */
const codexEntry = (lines: readonly string[]): string =>
  lines
    .map(l => uncommentToml(l).trim())
    .filter(l => l !== "")
    .join("\n");

/** The command one server's tables name, as the machine will run it. */
function codexCommand(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const code = uncommentToml(line);
    const m = /^\s*command\s*=\s*/.exec(code);
    if (m !== null) return tomlStrings(code.slice(m[0].length))[0];
  }
  return undefined;
}

/** A kept server's line with every string on it as the machine reads it. */
const codexRewrite = (lib: McpEditLib, line: string): string =>
  rewriteTomlLine(line, value => lib.rewriteString(value, /^\s*command\s*=/.test(uncommentToml(line))));

/** The editor: each line belongs to the server whose header came last (its sub-tables included), so a dropped
 * server's lines go and a kept one's strings are rewritten. */
function codexEditor(lib: McpEditLib, scope: McpEditScope, before: string): McpEdited {
  const lines = before.split("\n");
  const owner = codexOwners(lines);
  const keep = new Set(scope.keep);
  const drop = new Set(scope.drop);
  const out: string[] = [];
  const outOwner: (string | undefined)[] = [];
  lines.forEach((line, i) => {
    const o = owner[i];
    if (o !== undefined && drop.has(o)) return;
    out.push(o !== undefined && keep.has(o) ? codexRewrite(lib, line) : line);
    outOwner.push(o);
  });
  const results: McpEditResult[] = [];
  for (const name of scope.keep) {
    if (!owner.includes(name)) {
      results.push({ name, outcome: "missing" });
      continue;
    }
    results.push({ name, outcome: "written", command: codexCommand(out.filter((_, i) => outOwner[i] === name)) });
  }
  for (const name of scope.drop) results.push({ name, outcome: "dropped" });
  return { text: out.join("\n"), results };
}

/** The merge: wsp's tables spliced into the file Codex keeps for itself. A name it has no table for is appended
 * after a blank line as `place` appends one; a name whose table is wsp's own is written over in place; every other
 * line of theirs, the trust tables and the hooks state included, stays byte for byte. */
function codexMerge(lib: McpEditLib, scope: McpMergeScope, own: string | undefined, travelled: string): McpMerged {
  const from = travelled.split("\n");
  const replace = new Set(scope.replace);
  let lines = own === undefined ? [] : own.split("\n");
  const results: McpMergeResult[] = [];
  let wrote = false;
  const append = (block: readonly string[]): void => {
    const kept = [...lines];
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
    lines = kept.length === 0 ? [...block, ""] : [...kept, "", ...block, ""];
  };
  /** The block in place of the lines it stands on, which for an empty block is those lines taken out. */
  const over = (at: readonly number[], block: readonly string[]): void => {
    lines = lines.flatMap((line, i) => (i === at[0] ? block : at.includes(i) ? [] : [line]));
  };
  for (const name of scope.keep) {
    const at = codexBlock(from, name, true);
    if (at.length === 0) {
      results.push({ name, outcome: "missing" });
      continue;
    }
    const block = at.map(i => codexRewrite(lib, from[i]!));
    const said = (outcome: McpMergeResult["outcome"]): void => void results.push({ name, outcome, command: codexCommand(block) });
    const here = codexBlock(lines, name, true);
    if (here.length === 0) {
      append(block);
      wrote = true;
      said("added");
    } else if (codexEntry(here.map(i => lines[i]!)) === codexEntry(block)) said("same");
    else if (!replace.has(name)) said("theirs");
    else {
      over(here, block);
      wrote = true;
      said("replaced");
    }
  }
  for (const name of scope.drop) {
    const here = codexBlock(lines, name, false);
    if (here.length === 0 || !replace.has(name)) {
      results.push({ name, outcome: "left" });
      continue;
    }
    over(here, []);
    wrote = true;
    results.push({ name, outcome: "dropped" });
  }
  return { text: wrote ? lines.join("\n") : own ?? "", results };
}

/** The remove: each named server's tables go with their sub-tables and the blank lines under them, the way a
 * dropped name goes in the merge, and every other line of the file, the trust tables and the hooks state
 * included, stays byte for byte. */
function removeCodex(text: string, names: readonly string[]): McpRemoved {
  let lines = text.split("\n");
  let took = false;
  for (const name of names) {
    const at = new Set(codexBlock(lines, name, false));
    if (at.size === 0) continue;
    lines = lines.filter((_, i) => !at.has(i));
    took = true;
  }
  return { text: took ? lines.join("\n") : text };
}

/** The switch: `enabled = false` as the first line of the server's own table turns it off, and on takes the line out;
 * its sub-tables and every other line stay byte for byte. */
function enableCodex(text: string, name: string, on: boolean): Placed {
  const lines = text.split("\n");
  const headerOf = (l: string): { name: string; sub?: string } | undefined => {
    const t = uncommentToml(l).trim();
    return t.startsWith("[") ? tomlHeader(t) : undefined;
  };
  const start = lines.findIndex(l => {
    const h = headerOf(l);
    return h?.name === name && h.sub === undefined;
  });
  if (start < 0) throw new Error(`the file names no server called ${name}`);
  let end = start + 1;
  while (end < lines.length && !uncommentToml(lines[end]!).trim().startsWith("[")) end++;
  const at = lines.findIndex((l, i) => i > start && i < end && /^\s*enabled\s*=/.test(uncommentToml(l)));
  const next = on ? lines.filter((_, i) => i !== at) : at >= 0 ? lines.map((l, i) => (i === at ? "enabled = false" : l)) : [...lines.slice(0, start + 1), "enabled = false", ...lines.slice(start + 1)];
  return { text: next.join("\n") };
}

/** The key a line of a table sets, unquoted; nothing for a line that sets none. */
function tomlKey(line: string): string | undefined {
  const code = uncommentToml(line);
  const eq = code.indexOf("=");
  return eq < 0 ? undefined : code.slice(0, eq).trim().replace(/^"(.*)"$/, "$1");
}

/** Codex's text edited line by line toward the tree referCodex wants, for the spellings the line reader reads: a
 * server's http_headers and env, inline or as their own tables, go, and its bearer_token_env_var, env_http_headers and
 * env_vars name the variables instead, every other line byte for byte. */
function referCodexLines(text: string, only?: string): string {
  let lines = text.split("\n");
  for (const s of readCodex(text)) {
    if (only !== undefined && s.name !== only) continue;
    const headers = s.transport.kind === "http" ? s.transport.headers : {};
    const env = s.transport.kind === "stdio" ? s.transport.env : {};
    if (Object.keys(headers).length + Object.keys(env).length === 0) continue;
    const owner = codexOwners(lines);
    const subs = lines.map(l => {
      const t = uncommentToml(l).trim();
      return t.startsWith("[") ? tomlHeader(t)?.sub : undefined;
    });
    /** Each line's sub-table within the server, carried down from the header above it. */
    let sub: string | undefined;
    const subOf = lines.map((_, i) => (owner[i] !== s.name ? undefined : (sub = uncommentToml(lines[i]!).trim().startsWith("[") ? subs[i] : sub)));
    const mine = (i: number): boolean => owner[i] === s.name;
    const head = lines.findIndex((l, i) => mine(i) && uncommentToml(l).trim().startsWith("[") && subs[i] === undefined);
    const mainKey = (key: string): number => lines.findIndex((l, i) => mine(i) && i > head && subOf[i] === undefined && tomlKey(l) === key);
    const hasBearer = mainKey("bearer_token_env_var") >= 0;
    let bearer: string | undefined;
    const envHeaders: [string, string][] = [];
    const minted = headerVariables(s.name, Object.keys(headers));
    for (const [h, v] of Object.entries(headers)) {
      const token = hasBearer || bearer !== undefined ? undefined : bearerToken(h, v);
      const n = minted.get(h)!;
      if (token !== undefined) bearer = n;
      else envHeaders.push([h, n]);
    }
    const envNames = Object.keys(env);
    const drop = new Set(lines.flatMap((l, i) => (mine(i) && (subOf[i] === "http_headers" || subOf[i] === "env" || (subOf[i] === undefined && i > head && (tomlKey(l) === "http_headers" || tomlKey(l) === "env"))) ? [i] : [])));
    const replace = new Map<number, string[]>();
    const added: string[] = [];
    if (bearer !== undefined) added.push(`bearer_token_env_var = ${tomlString(bearer)}`);
    if (envHeaders.length > 0) {
      const inline = mainKey("env_http_headers");
      const table = lines.findIndex((l, i) => mine(i) && subs[i] === "env_http_headers" && uncommentToml(l).trim().startsWith("["));
      if (inline >= 0) replace.set(inline, [`env_http_headers = ${tomlInline({ ...(tomlValue(uncommentToml(lines[inline]!).slice(uncommentToml(lines[inline]!).indexOf("=") + 1)) as Record<string, string>), ...Object.fromEntries(envHeaders) })}`]);
      else if (table >= 0) {
        let last = table;
        for (let i = table + 1; i < lines.length && subOf[i] === "env_http_headers" && mine(i); i++) if (lines[i]!.trim() !== "") last = i;
        replace.set(last, [lines[last]!, ...envHeaders.map(([h, n]) => `${tomlString(h)} = ${tomlString(n)}`)]);
      } else added.push(`env_http_headers = ${tomlInline(Object.fromEntries(envHeaders))}`);
    }
    if (envNames.length > 0) {
      const at = mainKey("env_vars");
      if (at >= 0) {
        let end = at;
        let value = uncommentToml(lines[at]!).slice(uncommentToml(lines[at]!).indexOf("=") + 1).trim();
        while (tomlOpenArray(value) && end + 1 < lines.length) value += uncommentToml(lines[++end]!).trim();
        const had = tomlStrings(value);
        replace.set(at, [`env_vars = [${[...had, ...envNames.filter(k => !had.includes(k))].map(tomlString).join(", ")}]`]);
        for (let i = at + 1; i <= end; i++) drop.add(i);
      } else added.push(`env_vars = [${envNames.map(tomlString).join(", ")}]`);
    }
    lines = lines.flatMap((l, i) => (i === head ? [l, ...added] : drop.has(i) ? [] : (replace.get(i) ?? [l])));
  }
  return lines.join("\n");
}

/** The reference writer for Codex: the file read whole by a TOML parser, so a server's headers and variables read the
 * same however the file spells them (a table, a sub-table, an inline table, a dotted key, a quoted name), and the tree
 * rewritten by name. The text the line editor makes is kept where it parses to that same tree, which keeps every
 * comment; any other spelling is written out from the tree. The parser is loaded on the first call: every host
 * process carries this module and the host's memory has a budget, so nothing that never writes a Codex file pays it. */
async function referCodex(text: string, only?: string): Promise<McpReferred> {
  const { parse: parseToml, stringify: stringifyToml } = await import("smol-toml");
  let tree: Record<string, unknown>;
  try {
    tree = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`the file is not valid TOML (${(e instanceof Error ? e.message : String(e)).split("\n")[0]})`);
  }
  const unread = (where: string): Error => new Error(`${where} is written in a shape wsp does not read, so its values cannot be written by name`);
  const table = tree["mcp_servers"];
  if (table === undefined) return { text, servers: [], entries: [] };
  if (!isObject(table)) throw unread("mcp_servers");
  const servers: McpReferred["servers"] = [];
  const next: Record<string, unknown> = { ...table };
  let changed = false;
  for (const [name, raw] of Object.entries(table)) {
    if (!isObject(raw)) throw unread(`mcp_servers.${name}`);
    for (const key of ["http_headers", "env"]) {
      const held = raw[key];
      if (held !== undefined && (!isObject(held) || Object.values(held).some(v => typeof v !== "string"))) throw unread(`mcp_servers.${name}`);
    }
    if (only !== undefined && name !== only) continue;
    const headers = dict(raw["http_headers"]);
    const env = dict(raw["env"]);
    const values: Record<string, string> = {};
    servers.push({ name, values });
    if (Object.keys(headers).length + Object.keys(env).length === 0) continue;
    const minted = headerVariables(name, Object.keys(headers));
    let bearer = typeof raw["bearer_token_env_var"] === "string" ? undefined : ("" as string | undefined);
    const envHeaders: Record<string, string> = {};
    for (const [h, v] of Object.entries(headers)) {
      const n = minted.get(h)!;
      const token = bearer === "" ? bearerToken(h, v) : undefined;
      values[n] = token ?? v;
      if (token !== undefined) bearer = n;
      else envHeaders[h] = n;
    }
    for (const [k, v] of Object.entries(env)) if (v !== "") values[k] = v;
    const def: Record<string, unknown> = { ...raw };
    delete def["http_headers"];
    delete def["env"];
    if (bearer !== undefined && bearer !== "") def["bearer_token_env_var"] = bearer;
    if (Object.keys(envHeaders).length > 0) def["env_http_headers"] = { ...dict(raw["env_http_headers"]), ...envHeaders };
    if (Object.keys(env).length > 0) {
      const had = Array.isArray(raw["env_vars"]) ? (raw["env_vars"] as unknown[]) : [];
      def["env_vars"] = [...had, ...Object.keys(env).filter(k => !had.includes(k))];
    }
    next[name] = def;
    changed = true;
  }
  if (!changed) return { text, servers, entries: Object.values(table) };
  const want = { ...tree, mcp_servers: next };
  let out: string;
  try {
    const lined = referCodexLines(text, only);
    out = jsonCanonical(parseToml(lined)) === jsonCanonical(want) ? lined : stringifyToml(want);
  } catch {
    out = stringifyToml(want);
  }
  const entries = Object.values(((parseToml(out) as Record<string, unknown>)["mcp_servers"] ?? {}) as Record<string, unknown>);
  stillStands(entries, servers);
  return { text: out, servers, entries };
}

export const CODEX_TOML: McpFormat = {
  read: readCodex,
  place: (text, name, server) => ({ text: placeCodex(text, name, server) }),
  edit: codexEditor,
  entryOf: (text, name) => {
    const lines = text.split("\n");
    const at = codexBlock(lines, name, true);
    return at.length === 0 ? undefined : codexEntry(at.map(i => lines[i]!));
  },
  merge: codexMerge,
  remove: removeCodex,
  enable: enableCodex,
  refer: referCodex,
};
