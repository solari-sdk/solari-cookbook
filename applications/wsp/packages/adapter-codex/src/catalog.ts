// SPDX-License-Identifier: AGPL-3.0-only
// What the installed Codex binary reports about itself, read without a turn:
// `codex --version`, the sandbox choices in `codex --help`, and four requests
// to `codex app-server`, the JSON-RPC face codex's own clients use. model/list
// answers the models it offers with each model's reasoning efforts, config/read
// the model and provider a turn without flags would run (an OpenRouter route
// names a model no OpenAI catalog carries), and account/read whether the
// provider wants an OpenAI sign-in the machine has not got. Measured on
// codex-cli 0.153.0: all four answers land about 140 ms after the pipe opens,
// no model is called.
//
// The app-server exits the moment its stdin closes, before it has answered, so
// the probe holds its stdin open through a named pipe and closes it on the last
// answer: this line is awaited at a session start, and a fixed wait would be a
// wait the person sits through. The answers arrive in no fixed order (measured
// twice, id 3 and id 4 either way round), so the reader counts answers rather
// than watching for the last id it sent.

import { codexNotSignedInLine, shellQuote } from "@wsp/protocol";
import type { HarnessCatalogAnswer, HarnessCatalogModelProbe, HarnessCatalogProbe } from "@wsp/protocol";
import { buildEnv } from "./command.js";

const SEP = "__WSP_CATALOG_SEP__";
/** Request ids, in the order the probe sends them; the parser reads each answer by its own id. */
const INIT = 1;
const MODELS = 2;
const CONFIG = 3;
const ACCOUNT = 4;
/** How long the reader waits for one more line before giving up on the answers it has not had. Measured at 140 ms for
 * all four on 0.153.0, so this is the stall case only; it is under the runtime's 30s timeout on the whole probe. */
const LINE_WAIT_S = 10;

const request = (id: number, method: string, params: Record<string, unknown> = {}): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

const REQUESTS = [
  request(INIT, "initialize", { clientInfo: { name: "wsp", version: "0" } }),
  request(MODELS, "model/list"),
  request(CONFIG, "config/read"),
  request(ACCOUNT, "account/read"),
];

/**
 * The probe as one bash script for the guest, since guest exec is `bash -c` and may span lines. `cd ~` for the same
 * reason as a session: guest exec carries no HOME, and the app-server writes into the home it is pointed at, so the
 * probe runs under the session's own CODEX_HOME.
 */
export function catalogProbeCommand(options: { home: string; baseEnv?: Readonly<Record<string, string | undefined>> }): string {
  const env = buildEnv({ base: options.baseEnv, home: options.home });
  const exports = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
  const lines = REQUESTS.map(line => shellQuote(line)).join(" ");
  const server = [
    // Two named pipes rather than a coprocess: the Mac's own bash is 3.2, which has none, and the test proves this
    // line on whatever bash runs it.
    'WSP_PROBE_DIR=$(mktemp -d) && mkfifo "$WSP_PROBE_DIR/in" "$WSP_PROBE_DIR/out"',
    'codex app-server <"$WSP_PROBE_DIR/in" >"$WSP_PROBE_DIR/out" &',
    "WSP_APP_SERVER_PID=$!",
    'exec 3>"$WSP_PROBE_DIR/in" 4<"$WSP_PROBE_DIR/out"',
    `printf '%s\\n' ${lines} >&3`,
    "answers=0",
    `while [ "$answers" -lt ${String(REQUESTS.length)} ] && IFS= read -r -t ${String(LINE_WAIT_S)} -u 4 line; do`,
    `  printf '%s\\n' "$line"`,
    `  case $line in '{"id":'*) answers=$((answers + 1)) ;; esac`,
    "done",
    "exec 3>&- 4<&-",
    // Only ever the pid the shell recorded: bare `kill 0` would signal the whole group.
    'kill "$WSP_APP_SERVER_PID" 2>/dev/null || :',
    'rm -rf "$WSP_PROBE_DIR"',
  ].join("\n");
  return `cd ~ && export ${exports}; codex --version; echo ${SEP}; codex --help; echo ${SEP}\n${server}`;
}

/** The `[possible values: ...]` list `codex --help` prints under a flag; empty when the flag or the list is missing. */
function possibleValues(help: string, flag: string): string[] {
  const at = help.indexOf(flag);
  if (at === -1) return [];
  const values = /\[possible values:\s*([^\]]*)\]/.exec(help.slice(at, at + 600));
  if (values === null) return [];
  return values[1]!.split(",").map(s => s.trim()).filter(s => s.length > 0);
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Each JSON-RPC result in the section, by the id the probe sent it under. */
function results(section: string): Map<number, Record<string, unknown>> {
  const byId = new Map<number, Record<string, unknown>>();
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const message = rec(value);
    const result = rec(message?.result);
    if (typeof message?.id !== "number" || result === undefined) continue;
    byId.set(message.id, result);
  }
  return byId;
}

/** The models model/list offers, the ones it hides left out, each with the efforts and default effort it reports; the
 * effective model is the one marked default, and it leads the list where codex's own catalog does not carry it. */
function modelsOf(listed: Record<string, unknown> | undefined, configured: string | undefined): HarnessCatalogModelProbe[] {
  const rows = Array.isArray(listed?.data) ? listed.data : [];
  const models: HarnessCatalogModelProbe[] = [];
  for (const raw of rows) {
    const entry = rec(raw);
    const slug = str(entry?.id);
    if (entry === undefined || slug === undefined || entry.hidden === true) continue;
    const efforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.map(e => str(rec(e)?.reasoningEffort)).filter((e): e is string => e !== undefined)
      : [];
    const description = str(entry.description);
    const defaultEffort = str(entry.defaultReasoningEffort);
    models.push({
      slug,
      label: str(entry.displayName) ?? slug,
      ...(description !== undefined ? { description } : {}),
      efforts,
      ...(defaultEffort !== undefined ? { defaultEffort } : {}),
      contextWindows: [],
      isDefault: configured === undefined ? entry.isDefault === true : slug === configured,
    });
  }
  // A config that routes to another provider names a model codex's own catalog does not carry; it is what a turn
  // without -m runs, so it leads the list. Which efforts it takes is the provider's to answer and codex reports
  // none of them, so it names no list and every effort the catalog carries stays open to it, as it was before.
  if (configured !== undefined && !models.some(m => m.slug === configured)) {
    models.unshift({ slug: configured, label: configured, contextWindows: [], isDefault: true });
  }
  return models;
}

/** The efforts the listed models take between them, in the order the binary first named each. */
function effortsOf(models: readonly HarnessCatalogModelProbe[]): string[] {
  const efforts: string[] = [];
  for (const model of models) for (const effort of model.efforts ?? []) if (!efforts.includes(effort)) efforts.push(effort);
  return efforts;
}

/**
 * Null when the app-server said nothing at all: the caller falls back to its table. A refusal when it answered and
 * offered no model because its provider wants a sign-in the machine has not got, so the table stands with words for
 * why. `login` is the catalog's command for signing codex in on a machine, the one a failed turn already names.
 */
export function parseCatalogProbe(stdout: string, login: string): HarnessCatalogAnswer {
  const parts = stdout.split(SEP);
  if (parts.length < 3) return null;
  const [versionPart, help, serverPart] = parts as [string, string, string];
  const answers = results(serverPart);
  if (!answers.has(INIT)) return null;
  const config = rec(answers.get(CONFIG)?.["config"]);
  const models = modelsOf(answers.get(MODELS), str(config?.["model"]));
  if (models.length === 0) {
    const account = answers.get(ACCOUNT);
    const wantsSignIn = account?.["requiresOpenaiAuth"] === true && account["account"] === null;
    return wantsSignIn ? { refused: codexNotSignedInLine(login) } : null;
  }
  const probe: HarnessCatalogProbe = {
    version: /(\d+\.\d+\.\d+)/.exec(versionPart)?.[1] ?? null,
    models,
    efforts: effortsOf(models),
    permissionModes: possibleValues(help, "--sandbox <SANDBOX_MODE>"),
  };
  return probe;
}
