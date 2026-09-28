// SPDX-License-Identifier: AGPL-3.0-only
// What a shell line says the agent ran, as names: the first word of each
// command in it (after a pipe, an and, a semicolon, a subshell, a prefix like
// sudo or env) and the packages its install commands asked for. Heredoc
// bodies are cut before anything is read, quoted text is never split.
const SEPARATORS = new Set(["|", "||", "&&", ";", "&", "\n"]);
/** Words that run the command after them, options of their own skipped. */
const PREFIXES = new Set(["sudo", "doas", "env", "time", "nohup", "exec", "command", "builtin", "nice", "xargs", "caffeinate", "then", "do", "else", "if", "elif", "while", "until", "!"]);
/** The options of a prefix that take the next word as their value. */
const PREFIX_OPTION_ARGS: Readonly<Record<string, readonly string[]>> = { sudo: ["-u", "-g", "-h", "-p"], doas: ["-u"], nice: ["-n"], xargs: ["-I", "-n", "-P", "-d", "-L", "-s"] };
/** Shell syntax and builtins that start a command but run nothing on their own. */
const NOT_COMMANDS = new Set(["for", "case", "function", "fi", "done", "esac", "export", "local", "declare", "typeset", "readonly", "unset", "return", "exit", "break", "continue", "shift", "set", "cd", "echo", "printf", "true", "false", "[", "[[", "test", "wait", "trap", "source", ".", "alias", "eval", "read", ":"]);

/** A command that only asks whether a program is there or which version: `which x`, `command -v x`, or `x` with one
 * version flag (`--version`, `-version` as Java spells it, `-v`, `-V`) and nothing else. */
const LOOKUPS = new Set(["which"]);
const VERSION_FLAGS = new Set(["--version", "-version", "-v", "-V"]);
const COMMAND_LOOKUP_FLAGS = new Set(["-v", "-V"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A redirection on its own (`>`, `2>`, `&>`, `<`), its target the next word. */
const REDIRECT_ALONE = /^(?:\d*|&)[<>]{1,2}&?$/;
/** A redirection, its target attached or a descriptor (`>out.txt`, `2>/dev/null`, `2>&1`, `&>/dev/null`). */
const REDIRECT = /^(?:\d*|&)[<>]/;

/** The line with every heredoc body removed: from the line after `<<TAG` (quoted or not, dash or not) to the tag. */
export function withoutHeredocs(line: string): string {
  const out: string[] = [];
  let tag: string | undefined;
  for (const l of line.split("\n")) {
    if (tag !== undefined) {
      if (l.trim() === tag) tag = undefined;
      continue;
    }
    out.push(l);
    const m = /<<-?\s*(?:'([^']+)'|"([^"]+)"|(\w+))/.exec(l);
    if (m !== null) tag = m[1] ?? m[2] ?? m[3];
  }
  return out.join("\n");
}

/** The index of the brace closing the one at `open`, nested braces skipped; the last index when none closes it. */
function closingBrace(line: string, open: number): number {
  let depth = 0;
  for (let i = open; i < line.length; i += 1) {
    if (line[i] === "{") depth += 1;
    else if (line[i] === "}" && (depth -= 1) === 0) return i;
  }
  return line.length - 1;
}

/** The line cut into commands at unquoted separators, subshells and substitutions opened, a `$(...)` inside double
 * quotes too since its command runs; a `${...}` stays in its word; a `#` at the start of a word ends the line. */
export function splitCommands(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  /** The quote each open `(` or `$(` was met inside, put back when its `)` closes. */
  const opened: (string | undefined)[] = [];
  const flush = (): void => {
    if (cur.trim() !== "") out.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    const two = line.slice(i, i + 2);
    if (quote !== undefined) {
      if (c === "\\" && quote === '"') {
        cur += c + (line[i + 1] ?? "");
        i += 1;
      } else if (quote === '"' && two === "$(") {
        flush();
        opened.push(quote);
        quote = undefined;
        i += 1;
      } else if (c === quote) quote = undefined;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "\\") {
      cur += line[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (c === "#" && (i === 0 || /[\s;&|(){}]/.test(line[i - 1]!))) {
      flush();
      const end = line.indexOf("\n", i);
      i = end === -1 ? line.length : end - 1;
      continue;
    }
    if (SEPARATORS.has(two) || two === "$(") {
      flush();
      if (two === "$(") opened.push(undefined);
      i += 1;
      continue;
    }
    if (two === "${") {
      const end = closingBrace(line, i + 1);
      cur += line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === "(" || c === ")") {
      flush();
      if (c === "(") opened.push(undefined);
      else if (opened.length > 0) quote = opened.pop();
      continue;
    }
    // An ampersand beside a redirection (`2>&1`, `&>`) is part of it, not a background job.
    const redirect = c === "&" && (">" === line[i - 1] || "<" === line[i - 1] || line[i + 1] === ">");
    if (!redirect && (SEPARATORS.has(c) || c === "`" || c === "{" || c === "}")) {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return out;
}

/** The words of one command, prefixes and their options skipped, assignments skipped; empty for shell syntax alone. */
export function commandWords(command: string): string[] {
  const words = command.split(/\s+/).filter(w => w !== "");
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (ASSIGNMENT.test(w) || REDIRECT.test(w)) {
      i += REDIRECT_ALONE.test(w) ? 2 : 1;
      continue;
    }
    // `command -v x` looks x up and runs nothing, so it stays a command of its own for isVersionCheck to see.
    if (w === "command" && COMMAND_LOOKUP_FLAGS.has(words[i + 1] ?? "")) break;
    if (PREFIXES.has(w)) {
      const withArg = PREFIX_OPTION_ARGS[w] ?? [];
      i += 1;
      while (i < words.length && (words[i]!.startsWith("-") || (w === "env" && ASSIGNMENT.test(words[i]!)))) i += withArg.includes(words[i]!) ? 2 : 1;
      continue;
    }
    break;
  }
  const rest = words.slice(i);
  const head = rest[0];
  if (head === undefined || NOT_COMMANDS.has(head)) return [];
  return [head.slice(head.lastIndexOf("/") + 1), ...rest.slice(1)];
}

/** Whether one command's words only ask whether a program is there or which version it is; nothing was worked with. */
export function isVersionCheck(words: readonly string[]): boolean {
  const [head, arg] = words;
  if (head === undefined) return false;
  if (LOOKUPS.has(head)) return true;
  if (head === "command") return COMMAND_LOOKUP_FLAGS.has(arg ?? "");
  return words.length === 2 && VERSION_FLAGS.has(arg!);
}

/** The names of the programs a shell line runs, one per command in it, in order and with repeats; a version check
 * or a lookup is not a run. */
export function commandNames(line: string): string[] {
  return splitCommands(withoutHeredocs(line)).flatMap(c => {
    const words = commandWords(c);
    return isVersionCheck(words) ? [] : words.slice(0, 1);
  });
}

export interface Install {
  /** The installer: brew, npm, pnpm, bun, uv, pipx, cargo, go, apt; or a one-shot runner (npx, bunx, uvx, pipx-run). */
  via: string;
  name: string;
}

const NPM_INSTALL = new Set(["install", "i", "add"]);

/** `@scope/name@1.2.3` to `@scope/name`, `name@latest` to `name`, `pkg==1.0` to `pkg`, `mod/path@v1` to `path`. */
function bareName(spec: string, via: string): string {
  let s = spec;
  if (via === "go") {
    s = s.slice(0, s.indexOf("@") === -1 ? s.length : s.indexOf("@"));
    return s.slice(s.lastIndexOf("/") + 1).replace(/^v\d+$/, "") || s;
  }
  if (via === "uv" || via === "pipx" || via === "uvx" || via === "pipx-run") return s.split(/[=<>!~[]/)[0]!;
  const at = s.indexOf("@", 1);
  return at === -1 ? s : s.slice(0, at);
}

/** The words after `from` that are neither options nor redirections nor the target of a bare one. */
function positional(words: readonly string[], from: number): string[] {
  const out: string[] = [];
  for (let i = from; i < words.length; i += 1) {
    const w = words[i]!;
    if (REDIRECT_ALONE.test(w)) i += 1;
    else if (!w.startsWith("-") && !REDIRECT.test(w)) out.push(w);
  }
  return out;
}

/** The packages one command asks an installer for, with the installer; one-shot runs are listed under their runner. */
export function installsIn(command: string): Install[] {
  const w = commandWords(command);
  const head = w[0];
  if (head === undefined) return [];
  const at = (i: number, ...names: string[]): boolean => w[i] !== undefined && names.includes(w[i]!);
  const list = (via: string, from: number): Install[] => positional(w, from).map(name => ({ via, name: bareName(name, via) })).filter(i => i.name !== "");
  switch (head) {
    case "brew":
      return at(1, "install", "reinstall") ? list("brew", 2) : [];
    case "npm":
      return at(1, ...NPM_INSTALL) && w.slice(2).some(x => x === "-g" || x === "--global") ? list("npm", 2) : [];
    case "pnpm":
      return at(1, "add", "install", "i") && w.slice(2).some(x => x === "-g" || x === "--global") ? list("pnpm", 2) : [];
    case "bun":
      return at(1, "add", "install", "i") && w.slice(2).some(x => x === "-g" || x === "--global") ? list("bun", 2) : [];
    case "uv":
      return at(1, "tool") && at(2, "install") ? list("uv", 3) : [];
    case "pipx":
      if (at(1, "install")) return list("pipx", 2);
      return at(1, "run") ? list("pipx-run", 2).slice(0, 1) : [];
    case "cargo":
      return at(1, "install") ? list("cargo", 2) : [];
    case "go":
      return at(1, "install") ? list("go", 2) : [];
    case "apt":
    case "apt-get":
      return at(1, "install") ? list("apt", 2) : [];
    case "npx":
    case "bunx":
    case "uvx":
      return list(head, 1).slice(0, 1);
    default:
      return [];
  }
}

/** Every install a shell line asks for, across its commands. */
export function installNames(line: string): Install[] {
  return splitCommands(withoutHeredocs(line)).flatMap(installsIn);
}
