// SPDX-License-Identifier: AGPL-3.0-only
// The rc files as the pack and the logins rung read them. Exported variables
// whose name says KEY, TOKEN, SECRET or PASSWORD are listed by name and cut
// from a carried copy of the rc file, wherever on the line the assignment
// sits. Values never leave here, so a cut line takes its continuation and any
// open quote, substitution or heredoc with it.
import { RC_FILES as SHELL_RUNG_RC } from "./shell.js";

/** fish reads every .fish file directly in this directory at startup, before config.fish. */
export const FISH_CONF_D = ".config/fish/conf.d";

/** The rc files the shell rung carries, `~`-relative, plus fish's config; fish's conf.d files come through rcFiles and isRcPath. */
export const RC_PATHS = [...SHELL_RUNG_RC.map(n => `.${n}`), ".config/fish/config.fish"] as const;

/** The names an rc file goes by, for a copy of one found under another directory. */
export const RC_NAMES: ReadonlySet<string> = new Set(RC_PATHS.map(p => p.slice(p.lastIndexOf("/") + 1)));

/** Whether a `~`-relative path is an rc file: one of RC_PATHS, or a .fish file directly in conf.d. */
export function isRcPath(rel: string): boolean {
  if ((RC_PATHS as readonly string[]).includes(rel)) return true;
  return rel.slice(0, rel.lastIndexOf("/")) === FISH_CONF_D && rel.endsWith(".fish");
}

/** The rc files as `~`-relative paths: RC_PATHS and the .fish files in conf.d's listing. */
export function rcFiles(confD: readonly string[]): string[] {
  return [...RC_PATHS, ...confD.filter(n => n.endsWith(".fish")).map(n => `${FISH_CONF_D}/${n}`)];
}

const SECRET_WORDS = new Set(["KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD"]);

/** `KEYTIMEOUT` is not a key; the word has to stand alone between underscores. */
export function isSecretName(name: string): boolean {
  return name.toUpperCase().split("_").some(w => SECRET_WORDS.has(w));
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const EXPORTED = new RegExp(`^\\s*(?:export|typeset|declare|readonly|local|env)(?:\\s+-\\w+)*\\s+(.*)$`);
const FISH_SET = new RegExp(`^\\s*set(?:\\s+-\\w+)*\\s+(${NAME})(?:\\s|$)`);
const ASSIGNED = new RegExp(`^["']?(${NAME})=`);
const PLAIN = new RegExp(`^\\s*(${NAME})=`);
/** Words that open a compound command's body; what follows is a simple command of its own. */
const KEYWORDS = /^\s*(?:then|do|else|elif|if|while|until|exec|command|builtin|!)\s+/;
/** `eval 'export X=1'`: the quoted argument is shell again. */
const EVAL = /^\s*eval\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S.*))$/;

/** The simple commands of a line: split outside quotes on `;`, `&&`, `||`, `|`, `&` and braces or parentheses, comment dropped. */
export function simpleCommands(line: string): string[] {
  const out: string[] = [];
  let quote: "" | "'" | '"' = "";
  let cur = "";
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] ?? "";
    if (c === "\\" && quote !== "'") {
      cur += c + (line[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote !== "") {
      cur += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (commentAt(line, i)) break;
    if (";|&{}()".includes(c)) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map(s => {
    let t = s;
    for (let m = KEYWORDS.exec(t); m !== null; m = KEYWORDS.exec(t)) t = t.slice(m[0].length);
    return t;
  }).filter(s => s.trim() !== "");
}

function assignedIn(command: string): string[] {
  const ev = EVAL.exec(command);
  if (ev !== null) return assignedNames(ev[1] ?? ev[2] ?? ev[3] ?? "");
  const fish = FISH_SET.exec(command);
  if (fish?.[1] !== undefined) return [fish[1]];
  const exported = EXPORTED.exec(command);
  if (exported?.[1] !== undefined) {
    return exported[1].split(/\s+/).map(t => ASSIGNED.exec(t)?.[1]).filter((n): n is string => n !== undefined);
  }
  const plain = PLAIN.exec(command);
  return plain?.[1] === undefined ? [] : [plain[1]];
}

function assignedNames(line: string): string[] {
  return simpleCommands(line).flatMap(assignedIn);
}

/** What is still open at the end of a line: a quote, a backtick, `$(` or `${` groups, `((` arithmetic, a heredoc waiting for its word, or a trailing backslash. */
interface Open {
  quote: "" | "'" | '"' | "`" | "$'";
  parens: number;
  braces: number;
  /** Depth of `((` and `$((`; while open, `<<` is a shift and never a heredoc. */
  arith: number;
  heredoc?: string;
  continues: boolean;
}

const CLOSED: Open = { quote: "", parens: 0, braces: 0, arith: 0, continues: false };

function isOpen(o: Open): boolean {
  return o.quote !== "" || o.parens > 0 || o.braces > 0 || o.heredoc !== undefined || o.continues;
}

/** `<<WORD`, `<<-WORD`, `<<"WORD"`, `<<\WORD`: the word starts with a letter or underscore, so `x << 2` is arithmetic. The caller skips `<<<` (a here-string) and `<<` inside `(( ))` before this runs. */
const HEREDOC = /^<<-?\s*(?:"([A-Za-z_]\w*)"|'([A-Za-z_]\w*)'|\\([A-Za-z_]\w*)|([A-Za-z_]\w*))/;

/** A `#` outside quotes at the start of a word begins a comment; nothing after it is shell. After `(` or `{` it is a zsh glob flag, a brace expansion or `${#var}`, never a comment. */
function commentAt(line: string, i: number): boolean {
  return line[i] === "#" && (i === 0 || /[\s;&|]/.test(line[i - 1] ?? ""));
}

/** Carries the shell's quoting state across a line. Inside a heredoc only the terminator word matters. */
function scanLine(line: string, start: Open): Open {
  const o: Open = { ...start, continues: false };
  if (o.heredoc !== undefined) {
    if (line.trim() === o.heredoc) delete o.heredoc;
    return o;
  }
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    o.continues = false;
    if (c === "\\" && o.quote !== "'") {
      if (i === line.length - 1) o.continues = true;
      i += 1;
      continue;
    }
    if (o.quote === "$'") {
      if (c === "'") o.quote = "";
      continue;
    }
    if (o.quote === "'" || o.quote === "`") {
      if (c === o.quote) o.quote = "";
      continue;
    }
    if (o.quote === "" && commentAt(line, i)) break;
    if (o.quote === "" && c === "$" && line[i + 1] === "'") {
      o.quote = "$'";
      i += 1;
      continue;
    }
    if (o.quote === "" && (c === "'" || c === "`")) {
      o.quote = c;
      continue;
    }
    if (c === '"') {
      o.quote = o.quote === '"' ? "" : '"';
      continue;
    }
    if (o.quote === "" && c === "$" && line[i + 1] === "(" && line[i + 2] === "(") {
      o.arith += 1;
      i += 2;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      o.parens += 1;
      i += 1;
      continue;
    }
    if (c === "$" && line[i + 1] === "{") {
      o.braces += 1;
      i += 1;
      continue;
    }
    if (o.quote === "" && c === "(" && line[i + 1] === "(") {
      o.arith += 1;
      i += 1;
      continue;
    }
    if (o.quote === "" && c === ")" && line[i + 1] === ")" && o.arith > 0) {
      o.arith -= 1;
      i += 1;
      continue;
    }
    if (c === ")" && o.parens > 0) {
      o.parens -= 1;
      continue;
    }
    if (c === "}" && o.braces > 0) {
      o.braces -= 1;
      continue;
    }
    if (c === "<" && line[i + 1] === "<" && line[i + 2] === "<") {
      i += 2;
      continue;
    }
    if (o.quote === "" && o.arith === 0 && c === "<") {
      const m = HEREDOC.exec(line.slice(i));
      const word = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4];
      if (word !== undefined) {
        o.heredoc = word;
        break;
      }
    }
  }
  return o;
}

/** What a kept line may carry forward: a heredoc it opens and the depth of an arithmetic block it left open, and nothing else, since a comment's stray quote must never hide what follows. An open `((` only stops `<<` from being read as a heredoc until its `))`, which over-cuts a heredoc body and never leaks. */
function carried(line: string, arith: number): Pick<Open, "heredoc" | "arith"> {
  const o = scanLine(line, { ...CLOSED, arith });
  return { heredoc: o.heredoc, arith: o.arith };
}

/** The arithmetic depth is one stream over the file: a cut line reads it and writes it back like a kept line does. */
export function stripExports(text: string): { names: string[]; carried: string } {
  const names: string[] = [];
  const kept: string[] = [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let cutting: Open | undefined;
  let passing: Pick<Open, "heredoc" | "arith"> = { arith: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (cutting !== undefined) {
      const o = scanLine(line, cutting);
      if (isOpen(o)) cutting = o;
      else {
        cutting = undefined;
        passing = { arith: o.arith };
      }
      continue;
    }
    if (passing.heredoc !== undefined) {
      kept.push(line);
      if (line.trim() === passing.heredoc) passing = { arith: passing.arith };
      continue;
    }
    const hits = assignedNames(line).filter(isSecretName);
    if (hits.length === 0) {
      kept.push(line);
      passing = carried(line, passing.arith);
      continue;
    }
    for (const h of hits) if (!names.includes(h)) names.push(h);
    const o = scanLine(line, { ...CLOSED, arith: passing.arith });
    if (isOpen(o)) cutting = o;
    else passing = { arith: o.arith };
  }
  return { names, carried: kept.join(eol) };
}

const SOURCE = /^([ \t]*)(source|\\?\.)[ \t]+("[^"]*"|'[^']*'|[^\s;&|<>()"'\\`]+)(?=[\s;&|<>()]|$)(.*)$/;

export interface SourceCommand {
  indent: string;
  word: string;
  /** As written, quotes included. */
  token: string;
  /** Everything after the token. */
  rest: string;
}

/** A command that reads a file: its `source` or `.` word (nvm writes `\.` to dodge an alias on the dot), the one token after it and what follows. */
export function sourceCommand(command: string): SourceCommand | undefined {
  const m = SOURCE.exec(command);
  return m === null ? undefined : { indent: m[1]!, word: m[2]!, token: m[3]!, rest: m[4]! };
}

/** The file a source token names, absolute, when the token is literal: `~/`, `$HOME/` and `${HOME}/` fold to home; a
 * variable elsewhere, a glob, a substitution, an escape or an empty, `.` or `..` segment is left to a running shell. */
export function sourcedPath(token: string, home: string): string | undefined {
  const raw = /^(["']).*\1$/.test(token) ? token.slice(1, -1) : token;
  const path = raw.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, () => home);
  if (!path.startsWith("/") || /[$`*?[\]\\]/.test(path) || path.split("/").slice(1).some(seg => seg === "" || seg === "." || seg === "..")) return undefined;
  return path;
}

/** The files an rc file reads with `source` or `.` by a literal path, anywhere on the line, in order, once each. */
export function sourcedPaths(text: string, home: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    // simpleCommands splits on braces, so `${HOME}` is folded before the split.
    for (const cmd of simpleCommands(line.replace(/\$\{HOME\}/g, "$HOME"))) {
      const src = sourceCommand(cmd);
      const p = src === undefined ? undefined : sourcedPath(src.token, home);
      if (p !== undefined && !out.includes(p)) out.push(p);
    }
  }
  return out;
}
