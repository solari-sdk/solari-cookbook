// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isGitForge, type PlaceView, type SshHostSuggestion } from "@wsp/protocol";

/** The two reads the ssh folder needs: a file's text, or the names in a folder; either absent when it is not there. */
export interface SshFiles {
  read(path: string): string | undefined;
  list(dir: string): readonly string[] | undefined;
}

const nodeFiles: SshFiles = {
  read: path => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  list: dir => {
    try {
      return readdirSync(dir);
    } catch {
      return undefined;
    }
  },
};

type ConfigHost = Omit<SshHostSuggestion, "from">;

/** ssh's own nesting limit for Include. */
const INCLUDE_DEPTH = 16;

const isPattern = (word: string): boolean => /[*?!]/.test(word);
const isIp = (word: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(word) || word.includes(":");
/** The longest word the wire takes for a name, a login or an address: a longer one is no host anybody typed. */
const WORD_MAX = 300;
const fits = (host: ConfigHost): boolean => [host.alias, host.hostName, host.user].every(word => word === undefined || word.length <= WORD_MAX);
/** A port as either file writes it: digits alone, from 1 to 65535. Anything else is a line ssh would refuse. */
function portOf(word: string): number | undefined {
  if (!/^\d{1,5}$/.test(word)) return undefined;
  const port = Number(word);
  return port >= 1 && port <= 65535 ? port : undefined;
}

/** Whether a name matches a glob of `*` and `?`, walking both once and going back only to the last star, so the time
 * is bounded by the two lengths multiplied whatever the pattern holds. */
function globMatch(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p++;
      n++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      resume = n;
    } else if (star !== -1) {
      p = star + 1;
      n = ++resume;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

const unquote = (word: string): string => (word.length >= 2 && word.startsWith('"') && word.endsWith('"') ? word.slice(1, -1) : word);

/** A config line's keyword, lowercased, and its arguments, split as ssh splits them: whitespace or one `=`. */
function configLine(raw: string): { key: string; args: string[] } | undefined {
  const line = raw.trim();
  if (line === "" || line.startsWith("#")) return undefined;
  const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (m === null) return { key: line.toLowerCase(), args: [] };
  const args = (m[2]!.match(/"[^"]*"|\S+/g) ?? []).map(unquote);
  return { key: m[1]!.toLowerCase(), args };
}

/** The paths one Include argument names: relative to the ssh folder, `~` the home folder above it, a glob in the
 * last segment matched against that folder's names in order. */
function includePaths(arg: string, sshDir: string, files: SshFiles): string[] {
  const path = arg.startsWith("~/") ? join(dirname(sshDir), arg.slice(2)) : isAbsolute(arg) ? arg : resolve(sshDir, arg);
  const dir = dirname(path);
  const last = path.slice(dir.length + 1);
  if (!/[*?]/.test(last)) return [path];
  return [...(files.list(dir) ?? [])].filter(name => globMatch(last, name)).sort().map(name => join(dir, name));
}

/** Every named host of one config file and what it includes, in file order. A value set twice for one name keeps the
 * first, as ssh does; a block of patterns or a Match block lends nothing to a named host. */
function configHosts(path: string, sshDir: string, files: SshFiles, seen: Set<string>, into: Map<string, ConfigHost>, depth = 0): void {
  if (seen.has(path) || depth > INCLUDE_DEPTH) return;
  seen.add(path);
  const text = files.read(path);
  if (text === undefined) return;
  let block: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = configLine(raw);
    if (line === undefined) continue;
    const value = line.args[0];
    if (line.key === "host") {
      block = line.args.filter(word => !isPattern(word));
      for (const alias of block) if (!into.has(alias)) into.set(alias, { alias });
    } else if (line.key === "match") {
      block = [];
    } else if (line.key === "include") {
      for (const arg of line.args) for (const included of includePaths(arg, sshDir, files)) configHosts(included, sshDir, files, seen, into, depth + 1);
    } else if (value !== undefined) {
      for (const alias of block) {
        const host = into.get(alias)!;
        if (line.key === "hostname" && host.hostName === undefined) host.hostName = value;
        else if (line.key === "user" && host.user === undefined) host.user = value;
        else if (line.key === "port" && host.port === undefined) {
          const port = portOf(value);
          if (port !== undefined) host.port = port;
        }
      }
    }
  }
}

/** Each plain line of known_hosts as the names it holds, the first one the name offered and a bracketed port kept. A
 * line whose bracketed port is no port is left out whole. */
function knownHosts(text: string): { names: string[]; port?: number }[] {
  const rows: { names: string[]; port?: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("@") || line.startsWith("|")) continue;
    const field = line.split(/\s+/)[0]!;
    let port: number | undefined;
    const names: string[] = [];
    let bad = false;
    for (const entry of field.split(",")) {
      const bracketed = /^\[([^\]]+)\]:(.*)$/.exec(entry);
      const name = bracketed === null ? entry : bracketed[1]!;
      if (name === "" || isPattern(name) || name.startsWith("|")) continue;
      if (bracketed !== null) {
        const at = portOf(bracketed[2]!);
        if (at === undefined) bad = true;
        else port ??= at;
      }
      names.push(name);
    }
    if (!bad && names.length > 0) rows.push({ names, ...(port === undefined ? {} : { port }) });
  }
  return rows;
}

/** The host a place's ssh login names, less the user and a trailing port. */
function loginHost(login: string): string {
  const host = login.slice(login.lastIndexOf("@") + 1);
  return /^[^:]+:\d+$/.test(host) ? host.slice(0, host.indexOf(":")) : host;
}

/** The hosts the person's ssh already knows under `sshDir`, the config's first and then known_hosts, each once, less
 * the computers already added (by the host their ssh login names or the address their link last dialled from) and
 * the git forges. Opens the config, what it includes and known_hosts, and takes only host, hostname, user and port
 * words from them, so a key file an Include reaches yields nothing. */
export function sshHostsIn(sshDir: string, places: readonly Pick<PlaceView, "road">[], files: SshFiles = nodeFiles): SshHostSuggestion[] {
  const taken = new Set<string>();
  for (const place of places) {
    if (place.road?.ssh !== undefined) taken.add(loginHost(place.road.ssh));
    if (place.road?.from !== undefined) taken.add(place.road.from);
  }
  const config = new Map<string, ConfigHost>();
  configHosts(join(sshDir, "config"), sshDir, files, new Set(), config);
  const named = new Set<string>();
  const out: SshHostSuggestion[] = [];
  for (const host of config.values()) {
    named.add(host.alias);
    if (host.hostName !== undefined) named.add(host.hostName);
    if (!fits(host) || isGitForge(host.alias) || (host.hostName !== undefined && isGitForge(host.hostName)) || taken.has(host.alias) || (host.hostName !== undefined && taken.has(host.hostName))) continue;
    out.push({ ...host, from: "config" });
  }
  const text = files.read(join(sshDir, "known_hosts"));
  for (const row of text === undefined ? [] : knownHosts(text)) {
    if (row.names.some(name => named.has(name))) continue;
    for (const name of row.names) named.add(name);
    if (row.names.some(name => taken.has(name) || isGitForge(name))) continue;
    const alias = row.names.find(name => !isIp(name)) ?? row.names[0]!;
    if (!fits({ alias })) continue;
    out.push({ alias, ...(row.port === undefined ? {} : { port: row.port }), from: "known_hosts" });
  }
  return out;
}
