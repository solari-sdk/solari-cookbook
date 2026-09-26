// SPDX-License-Identifier: AGPL-3.0-only
// The shell line that runs one Codex turn on a workspace, as `codex exec
// --help` on codex-cli 0.153.0 spells the flags. The prompt travels on stdin
// through a quoted heredoc, since a long task as an argument would hit the
// kernel's per-argument cap, and `-` tells codex to read it there; the heredoc
// also closes stdin, which codex otherwise waits on when it is not a terminal.
// Images ride `-i`, one flag per image on both exec and resume: exec's flag
// takes many values and resume's one, and one flag each parses on both, with
// the `-` after it still read as the prompt (measured on 0.153.0, 2026-09-08).
import { inFolder, LAUNCH_ENV, MCP_SERVER_NAME, shellQuote, type McpServerSpec } from "@wsp/protocol";

const PROMPT_END = "WSP_PROMPT_END";
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** The sandbox modes `codex exec -s` takes; the one that turns the sandbox off is the flag that also skips approvals. */
const SANDBOXED = ["read-only", "workspace-write"];
const NO_SANDBOX = "danger-full-access";

export interface CodexEnvOptions {
  base?: Readonly<Record<string, string | undefined>>;
  /** Absolute path for CODEX_HOME, where the box's own login is mounted or a sign-in there wrote auth.json. */
  home: string;
  /** The API key the vault holds for this agent; set on every turn's environment. */
  apiKey?: string;
}

/** CODEX_HOME points codex at the home the sign-in wrote, since a guest exec carries no HOME to derive it from. */
export function buildEnv(options: CodexEnvOptions): Record<string, string> {
  const home = options.home.trim();
  if (!home.startsWith("/")) throw new Error(`home must be an absolute path, got "${options.home}"`);
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.base ?? {})) if (value !== undefined) clean[key] = value;
  // The key travels under both names. CODEX_API_KEY is the one this CLI's own login reads and prefers over the
  // store under CODEX_HOME (read_codex_api_key_from_env, codex-rs/login/src/auth/manager.rs at rust-v0.153.0);
  // OPENAI_API_KEY is read by a provider a person configured with env_key and by nothing in exec's own login.
  const key: Record<string, string> = options.apiKey === undefined ? {} : { CODEX_API_KEY: options.apiKey, OPENAI_API_KEY: options.apiKey };
  return { ...clean, CODEX_HOME: home, ...key };
}

export interface BuildCommandOptions {
  prompt: string;
  /** The thread id an earlier turn's thread.started announced; the turn continues that thread. */
  resume?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  /** One of the catalog's sandbox modes; absent runs without a sandbox, as every turn in a throwaway machine does. */
  permissionMode?: string;
  /** Absolute paths of images already on the machine; the CLI reads each off disk, so it takes no bytes of its own. */
  images?: readonly string[];
  /** MCP servers this turn gets besides the ones its config names, by the name each takes there. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
}

/** A value that may ride a codex command line or a SQL literal unquoted; anything else is refused before it does. */
export function slug(name: string, value: string): string {
  if (!SLUG_RE.test(value)) throw new Error(`${name} must be a plain slug, got "${value}"`);
  return value;
}

/** A config override whose value is a TOML string, which is JSON's quoting for these plain words. */
const config = (key: string, value: string): string => `-c ${key}=${shellQuote(JSON.stringify(value))}`;

/** A config override whose value is TOML already: a JSON array of strings is one. */
const configRaw = (key: string, toml: string): string => `-c ${key}=${shellQuote(toml)}`;

const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Each server as a whole config entry: an override naming only env_vars for a server the config does not hold stops
 * codex at start (measured on codex-cli 0.155.1). */
function serverFlags(servers: Readonly<Record<string, McpServerSpec>>): string[] {
  return Object.entries(servers).flatMap(([name, spec]) => {
    if (!SERVER_NAME_RE.test(name)) throw new Error(`an MCP server name must be one plain word of a config key, got "${name}"`);
    const at = `mcp_servers.${name}`;
    return [
      config(`${at}.command`, spec.command),
      configRaw(`${at}.args`, JSON.stringify(spec.args)),
      // Codex hands a server only its own short list of variables (codex-rs/rmcp-client/src/utils.rs at
      // rust-v0.155.1), so the launch's are named for the wsp one: names only, the values stay in the environment.
      ...(name === MCP_SERVER_NAME ? [configRaw(`${at}.env_vars`, JSON.stringify(LAUNCH_ENV))] : []),
    ];
  });
}

/** exec takes the mode as -s and resume has no such flag, so both set the config key the flag writes. */
function accessFlags(mode: string | undefined): string[] {
  if (mode === undefined || mode === NO_SANDBOX) return ["--dangerously-bypass-approvals-and-sandbox"];
  if (!SANDBOXED.includes(mode)) throw new Error(`permissionMode must be one of ${[...SANDBOXED, NO_SANDBOX].join(", ")}, got "${mode}"`);
  return [config("sandbox_mode", mode), config("approval_policy", "never")];
}

/**
 * The turn as one bash line: `codex exec` (or `codex exec resume <id>`) with JSONL events on stdout, outside a git
 * checkout allowed since a thread may start in the home folder, and the prompt as the heredoc on stdin. Guest exec
 * carries no HOME, so the default folder is `~`, which bash reads from passwd.
 */
export function buildCommand(options: BuildCommandOptions): string {
  const { prompt, resume, cwd, model, effort, permissionMode, images, mcpServers } = options;
  if (prompt.split("\n").includes(PROMPT_END)) throw new Error(`the prompt has a line that reads ${PROMPT_END}, which ends the prompt`);
  const codex = [
    "codex exec",
    ...(resume === undefined ? [] : [`resume ${slug("resume", resume)}`]),
    "--json",
    "--skip-git-repo-check",
    ...accessFlags(permissionMode),
    ...(model === undefined ? [] : [`-m ${slug("model", model)}`]),
    ...(effort === undefined ? [] : [config("model_reasoning_effort", slug("effort", effort))]),
    ...(images ?? []).map(path => `-i ${shellQuote(imagePath(path))}`),
    ...serverFlags(mcpServers ?? {}),
    "-",
  ].join(" ");
  return inFolder(cwd, `${codex} <<'${PROMPT_END}'\n${prompt}\n${PROMPT_END}`);
}

/** An image path is a plain absolute path on the machine, never a word the flag would read as another flag: `-i`
 * takes many values on exec and one on resume, so a value starting with a dash would be read as the next flag. */
function imagePath(path: string): string {
  if (!path.startsWith("/") || path.includes("\n")) throw new Error(`an image path must be one absolute path on the machine, got "${path}"`);
  return path;
}

/** Interrupt is a hard boundary, as it is for every harness: teardown (SIGTERM), then SIGKILL after this grace window. */
export const INTERRUPT_GRACE_MS = 5_000;
