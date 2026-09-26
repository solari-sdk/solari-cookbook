// SPDX-License-Identifier: AGPL-3.0-only
// The rules every client reads a seed menu by: what starts ticked, what a
// person's keeps and cuts do to that, the words each row ends in and the lines
// that say what would travel. The command line, the app and the tool all read
// them here, so the menu somebody reads and the archive somebody gets can
// never disagree about what was ticked.
import { fmtBytes, plural } from "./format.js";
import type { SeedChoice, SeedFile, SeedPlan } from "./index.js";


/** The folder a seed's own files ride in, which the landing unpacks and then removes: the agent's memory and the
 * patch of unpushed commits sit under it, so nothing of wsp's own is left inside the checkout. Written here
 * because the pack on this computer and the landing on the other side both name it. */
export const SEED_DIR = ".wsp-seed";
export const SEED_MEMORY_DIR = `${SEED_DIR}/memory`;
export const SEED_PATCH = `${SEED_DIR}/commits.patch`;

/** What the menu starts with: whatever each row is ticked as. A plan nobody has answered for carries the
 * catalogue's own judgment, every configuration row and nothing else; one built from a choice remembered for that
 * folder carries theirs, so an untick they asked to be kept is still unticked here. A login is never ticked
 * whatever a remembered choice says, since it never travels at all. The memory folder and the unpushed commits
 * ride on there being any. */
export function defaultSeedChoice(plan: SeedPlan): SeedChoice {
  return {
    files: plan.files.filter(f => f.ticked && f.kind !== "never").map(f => f.path),
    memory: plan.memory !== null,
    commits: plan.unpushed !== null,
  };
}

/** The choice a person's words make of the menu: the default, then the paths they named to keep and the ones they
 * named to cut, then the two flags that drop the memory folder and the patch. A kept path that the plan marks
 * `never` is refused by name here rather than at the pack, since that is where the person is still reading.
 * A keep names a path the menu showed, whatever its row: an unknown path is ticked by naming it. */
export function seedChoiceFrom(
  plan: SeedPlan,
  keep: readonly string[],
  cut: readonly string[],
  flags: { memory?: boolean; commits?: boolean; remember?: boolean } = {},
): SeedChoice {
  const known = new Map(plan.files.map(f => [f.path, f]));
  for (const path of keep) {
    const file = known.get(path);
    if (file === undefined) throw new Error(notInTheMenuLine(path, [...known.keys()]));
    if (file.kind === "never") throw new Error(neverTravelsLine(path, file.row?.name));
  }
  const base = defaultSeedChoice(plan);
  const files = plan.files.filter(f => (base.files.includes(f.path) || keep.includes(f.path)) && !cut.includes(f.path)).map(f => f.path);
  return {
    files,
    memory: flags.memory === false ? false : base.memory,
    commits: flags.commits === false ? false : base.commits,
    ...(flags.remember === true ? { remember: true } : {}),
  };
}

/** Why a path somebody asked to keep is not on the menu: the menu is git's own listing of what it ignores, so a
 * path that is not on it is either tracked already, which means the clone carries it, or not there at all. */
export const notInTheMenuLine = (path: string, shown: readonly string[]): string =>
  `${path} is not on the seed menu; git tracks it or it is not there, and the menu holds ${shown.length === 0 ? "nothing" : shown.join(", ")}`;

/** Why a login is refused even when it was ticked: it is signed in once per computer and a copy of one in a
 * project would be a second place the person's credential lives. */
export const neverTravelsLine = (path: string, row: string | undefined): string =>
  `${path} is ${row === undefined ? "a login" : `${row}, a login`}, and a login never travels in a seed; the computer's image carries its own sign-in`;

/** The words one menu row ends in, which say why it is ticked or not. */
export function seedRowWords(file: SeedFile): string {
  if (file.kind === "config") return file.row?.name ?? "config";
  if (file.kind === "rebuilt") return "rebuilt on the box";
  if (file.kind === "data") return "database, stop what uses it first";
  if (file.kind === "never") return "never travels";
  return "not in the catalogue";
}

/** The bytes a seed's ticked files come to, which is the number the menu shows and the number the record keeps:
 * the files the person ticked and nothing else, so the row they read and the record they can read back later say
 * one thing. The archive those files travel in is bigger, and its size is nobody's question. */
export function seedBytes(plan: SeedPlan, choice: SeedChoice): number {
  return plan.files.filter(f => choice.files.includes(f.path)).reduce((sum, f) => sum + f.bytes, 0);
}

/** What the seeding says as the person's files go to that computer: the same counts the menu showed them, in the
 * same order, and the folder they came from. The memory folder is counted on a row of its own, as it is on the
 * menu, so a seed of nothing but memory reads as nought files here too. */
export function seedingLine(plan: SeedPlan, choice: SeedChoice): string {
  const files = plan.files.filter(f => choice.files.includes(f.path)).length;
  const parts = [files === 0 ? "0 files" : `${plural(files, "file")} (${fmtBytes(seedBytes(plan, choice))})`];
  if (choice.memory && plan.memory !== null) parts.push(`Claude Code memory (${plural(plan.memory.files, "file")}, ${fmtBytes(plan.memory.bytes)})`);
  if (choice.commits && plan.unpushed !== null) parts.push(`${plural(plan.unpushed.commits, "commit")} the remote does not have`);
  return `Seeding ${parts.join(", ")}, from ${plan.source}.`;
}

/** What the seeding says once the computer's own git has answered, where the seed carried commits at all: the
 * count read back off the checkout there, which is nought where that clone already had the person's work. A
 * patch git refused says so in its own sentence and is not said twice. */
export const seedCommitsLandedLine = (commits: number): string => (commits === 0 ? "no commits to land" : `${plural(commits, "commit")} landed`);

/** What the person is told a seed would carry, before anything leaves this computer: the ticked paths with their
 * bytes, the memory folder, the patch, and the edits that stay here. One line each, in that order. */
export function seedSummaryLines(plan: SeedPlan, choice: SeedChoice): string[] {
  const ticked = plan.files.filter(f => choice.files.includes(f.path));
  const bytes = seedBytes(plan, choice);
  const lines = [ticked.length === 0 ? "no files travel" : `${plural(ticked.length, "file")}, ${fmtBytes(bytes)}: ${ticked.map(f => f.path).join(", ")}`];
  if (choice.memory && plan.memory !== null) lines.push(`Claude Code memory, ${plural(plan.memory.files, "file")}, ${fmtBytes(plan.memory.bytes)}`);
  if (choice.commits && plan.unpushed !== null) lines.push(`${plural(plan.unpushed.commits, "commit")} the remote does not have, as a patch from ${plan.unpushed.base.slice(0, 7)}`);
  if (plan.uncommitted > 0) lines.push(`${plural(plan.uncommitted, "uncommitted change")} stay on this computer`);
  return lines;
}

/** The menu as a terminal draws it: one row per path git ignores, ticked or not, with its size and the words its
 * catalog row ends in, then the memory folder, the unpushed commits and what stays here. The rows are cells for
 * the caller's own table, so the command line and the app pad them the way they pad every other table.
 * The rows are widest first: a package tree of three gigabytes is the thing a person looks for. */
export function seedMenuRows(plan: SeedPlan, choice: SeedChoice): string[][] {
  const tick = (on: boolean): string => (on ? "x" : " ");
  const files = [...plan.files].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return [
    ["", "PATH", "SIZE", "WHY"],
    ...files.map(f => [`[${tick(choice.files.includes(f.path))}]`, f.dir ? `${f.path}/` : f.path, fmtBytes(f.bytes), seedRowWords(f)]),
    ...(plan.memory === null ? [] : [[`[${tick(choice.memory)}]`, `${plan.memory.key}/memory`, fmtBytes(plan.memory.bytes), `Claude Code memory, ${plural(plan.memory.files, "file")}`]]),
    ...(plan.unpushed === null ? [] : [[`[${tick(choice.commits)}]`, `${plan.branch} as a patch`, "", `${plural(plan.unpushed.commits, "commit")} the remote does not have`]]),
  ];
}

/** What the command line says under the menu when nobody has consented yet: nothing was sent, and the two lines
 * that send it. Written here so the app's own dialog says the same about the same menu. */
export function seedConsentLines(plan: SeedPlan, computer: string, addLine: (flags: string) => string): string[] {
  return [
    `nothing was sent. ${plan.uncommitted > 0 ? `${plural(plan.uncommitted, "uncommitted change")} stay on this computer, and ` : ""}${computer} clones ${plan.remote ?? "the repo"} itself.`,
    `to send the ticked rows:   ${addLine("--yes")}`,
    `to change what travels:    ${addLine("--yes --keep <path> --cut <path> --no-memory --no-commits")}`,
  ];
}

/** What the add says about the paths a ticked folder held that never travel: a login inside a folder somebody
 * ticked stays on this computer, and the line names each one, so nothing they asked to carry is dropped in
 * silence. */
export const leftBehindLine = (paths: readonly string[]): string =>
  `${plural(paths.length, "login")} inside the folders you ticked stayed on this computer: ${paths.join(", ")}`;

/** What the add says when git refused the commits the remote has never seen: the person's own count and branch,
 * git's own last line for why, and where the checkout every copy of it takes now stands. The commits stay on the
 * person's computer, so this is a notice on an add that landed rather than a refusal. */
export const seedCommitsLostLine = (commits: number, branch: string, computer: string, said: string, back: string): string =>
  `the ${plural(commits, "commit")} on ${branch} did not land on ${computer}: ${said}; the checkout is on ${back}`;

/** Why a folder with no remote records nothing: the computer clones the repo, and a folder git has no remote for
 * gives it nothing to clone. */
export const noRemoteLine = (folder: string): string =>
  `${folder} has no origin remote, and the computer clones the repo rather than copying the folder; push it somewhere and add it again`;
