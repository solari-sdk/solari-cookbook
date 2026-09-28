// SPDX-License-Identifier: AGPL-3.0-only
// The base floor: what every golden gets before the person's recipe, from
// the catalog's floor rows by each row's own road, and the versions read back
// once they are on. It runs under the base stage ahead of the daemon, so the
// daemon deploy finds the tools its own steps type.
import { APT_INDEX, APT_UPDATE, BASE_FLOOR, installAfter, smokeOf } from "@wsp/catalog";
import { fmtBytes, type GoldenBaseTool, type GoldenStage } from "@wsp/protocol";
import { PRELUDE } from "./dotfiles-presets.js";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import { PATH_LINE, PROFILE_PATH_FILE, PROFILE_PATH_LINE, TOOLS_PATH, aptIndexStep, pathLine, viaRoad, type ToolInstall } from "./golden-import.js";
import { ALREADY_ON_MACHINE, installTools, type InstallToolsOptions, type ToolResult } from "./golden-tools.js";
import type { Machine } from "./machine.js";

const BASE_STAGE: GoldenStage = "deploying-daemon";

const stepId = (id: string): string => `base/${id}`;
const APT_STEP = stepId(APT_INDEX);

/** Every base step runs under the dotfiles prelude, ahead of the tools PATH the road helper puts on. */
const withEnv = (cmd: string): string => `${PRELUDE}\n${cmd}`;

/** The note above, re-exported where the floor's own readers have always found it. */
export { ALREADY_ON_MACHINE };

/** The floor as the tools loop runs it: one guarded step per row in catalog order through the row's road, each after
 * the row the catalog says it runs on top of; the apt index is read once, before the first row that waits on it. A
 * row `carried` names is left out, and a row that waited on one of those waits on nothing: what it needed is there. */
export function baseInstalls(carried: ReadonlySet<string> = new Set(), path: string = TOOLS_PATH, prefix?: string): ToolInstall[] {
  // A thread's terminal is a login shell and the stages export their PATH per step, so without this file the
  // terminal finds only what the image ships. Every golden gets it, whether or not Homebrew ever bootstraps.
  // The step runs on the job's own list; what it writes into the file is the login shell's PATH on that machine,
  // which is the tools PATH wherever a person's shell there looks for what the recipe installed.
  const out: ToolInstall[] = [{ id: stepId("login-path"), label: "login shell PATH", manager: "script", cmd: withEnv(`${pathLine(path, prefix)}\n${PROFILE_PATH_LINE}`), shown: `the tools PATH in ${PROFILE_PATH_FILE}` }];
  for (const e of BASE_FLOOR) {
    if (carried.has(e.id)) continue;
    const dep = installAfter(e);
    const waits = dep !== undefined && !carried.has(dep) ? dep : undefined;
    if (waits === APT_INDEX && !out.some(t => t.id === APT_STEP)) out.push(aptIndexStep(APT_STEP, withEnv(`${pathLine(path, prefix)}\n${APT_UPDATE}`)));
    const step = viaRoad(e.installRoad, e.bin, path, prefix);
    if (!("cmd" in step)) throw new Error(`${e.id}: ${step.note}`);
    out.push({ id: stepId(e.id), label: e.name, manager: e.installRoad.road, ...step, cmd: withEnv(step.cmd), ...(waits !== undefined ? { after: stepId(waits) } : {}), bin: e.bin });
  }
  return out;
}

interface VersionCheck {
  /** The name the line and the machine context show. */
  name: string;
  cmd: string;
  /** The floor row whose install put it there; absent for a command that rode in with another. */
  id?: string;
}

const VERSION_CHECKS: readonly VersionCheck[] = BASE_FLOOR.flatMap(e => [{ name: e.bin, cmd: smokeOf(e), id: e.id }, ...(e.brings ?? []).map(b => ({ name: b.bin, cmd: b.version }))]);

/** The number a version line has to carry to be worth reading, as the read and the parse below each spell it in
 * their own language: two runs of digits with a dot between them. The read keeps the first line carrying one rather
 * than the first line, since zip prints its copyright first and `This is Zip 3.0` second, and a floor row whose
 * version cannot be read installs on every update. */
const VERSION_NUMBER = /\d+\.\d+(?:\.\d+)?/;
const FIRST_VERSION_LINE = "grep -m1 -E '[0-9]+\\.[0-9]+'";

/** One `VERSION <name>: <version line>` echo per floor command, an empty value for one that is not there or prints
 * no version at all; the caller puts the tools PATH ahead. */
export const BASE_VERSION_LINES = VERSION_CHECKS.map(c => `echo "VERSION ${c.name}: $(${c.cmd} 2>/dev/null | ${FIRST_VERSION_LINE})"`).join("\n");

/** The read as one exec, as the base stage runs it, on the PATH the job was planned with. */
export const baseVersionsCmd = (path: string): string => `export PATH=${path}:$PATH\n${BASE_VERSION_LINES}`;

/** The versions the read printed, each as its number alone; a command that printed nothing, or nothing with a number in it, is left out. */
export function parseVersions(stdout: string): GoldenBaseTool[] {
  const out: GoldenBaseTool[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^VERSION ([^:]+): (.*)$/.exec(line.trimEnd());
    if (m === null) continue;
    const version = VERSION_NUMBER.exec(m[2]!)?.[0];
    if (version !== undefined) out.push({ name: m[1]!, version });
  }
  return out;
}

/** The floor rows the provider's image already satisfies, by entry id: every command the row promises answers with
 * a version, and where the row pins a major that version is on it. Their installs are not idempotent on an image
 * that ships the tool (apt-get install fails where the image's own copy stands), and an install that cannot make
 * the row truer than it is has nothing to do. A row that pins a major still runs when the image's is another: the
 * floor promises that major. */
export function carriedByImage(versions: readonly GoldenBaseTool[]): Set<string> {
  const read = new Map(versions.map(v => [v.name, v.version]));
  const out = new Set<string>();
  for (const e of BASE_FLOOR) {
    const names = [e.bin, ...(e.brings ?? []).map(b => b.bin)];
    if (!names.every(n => read.has(n))) continue;
    const major = e.major;
    if (major !== undefined && read.get(e.bin)!.split(".").slice(0, major.version.split(".").length).join(".") !== major.version) continue;
    out.add(e.id);
  }
  return out;
}

/** The base stage's closing words: each command with its version and, when df moved across its install, what it cost;
 * then every floor row nothing had to be done for, then every floor row that did not land, by its reason. */
export function versionsLine(versions: readonly GoldenBaseTool[], results: readonly ToolResult[]): string {
  const landed = versions.map(v => {
    const check = VERSION_CHECKS.find(c => c.name === v.name);
    const bytes = check?.id === undefined ? undefined : results.find(r => r.id === `base/${check.id}`)?.bytes;
    return `${v.name} ${v.version}${bytes !== undefined && bytes > 0 ? ` (${fmtBytes(bytes)})` : ""}`;
  });
  const already = results.filter(r => r.note === ALREADY_ON_MACHINE).map(r => r.label);
  const missed = results.filter(r => r.id !== APT_STEP && r.outcome !== "installed").map(r => `${r.label} ${r.outcome} (${r.note})`);
  return [landed.join(", "), ...(already.length > 0 ? [`${ALREADY_ON_MACHINE}: ${already.join(", ")}`] : []), ...missed].filter(s => s !== "").join("; ");
}

export interface BaseOutcome {
  tools: ToolResult[];
  /** What the read found on the machine; the sealed version records it. */
  versions: GoldenBaseTool[];
  /** The stage's closing words. */
  line: string;
}

/** Installs the floor and reads the versions back; the tools loop names each failure alone and skips what waited on
 * it. The same read runs first, against the image as the provider ships it: a row it already satisfies is recorded
 * as on the machine, in catalog order beside the rows that ran, and nothing is installed over it. `caches` is the
 * loop's own: a builder becomes an image and sweeps, a computer somebody owns keeps the caches that are theirs. */
export async function installBase(machine: Machine, stage: (stage: GoldenStage, detail?: string) => void, opts: Pick<InstallToolsOptions, "caches" | "path" | "prefix"> = {}): Promise<BaseOutcome> {
  const path = opts.path ?? TOOLS_PATH;
  const onImage = await machine.exec(baseVersionsCmd(path), { timeoutMs: INLINE_EXEC_MS });
  const carried = carriedByImage(parseVersions(onImage.stdout));
  const { tools } = await installTools(machine, baseInstalls(carried, path, opts.prefix), stage, BASE_STAGE, opts);
  const ran = new Map(tools.map(t => [t.id, t]));
  const floor = new Set(BASE_FLOOR.map(e => stepId(e.id)));
  // The floor's rows read in catalog order whether they ran or the image already had them; the loop's other steps
  // keep their place ahead of them.
  const results: ToolResult[] = [
    ...tools.filter(t => !floor.has(t.id)),
    ...BASE_FLOOR.flatMap((e): ToolResult[] => {
      if (carried.has(e.id)) return [{ id: stepId(e.id), label: e.name, outcome: "installed", note: ALREADY_ON_MACHINE }];
      const result = ran.get(stepId(e.id));
      return result === undefined ? [] : [result];
    }),
  ];
  const read = await machine.exec(baseVersionsCmd(path), { timeoutMs: INLINE_EXEC_MS });
  const versions = parseVersions(read.stdout);
  return { tools: results, versions, line: versionsLine(versions, results) };
}
