// SPDX-License-Identifier: AGPL-3.0-only
// The landing roads as modules, one per kind of computer a project can be
// added on: where that computer keeps the checkout and the project's memory,
// what the add runs there to clone, seed and install, and what every workspace
// of the project then binds. The add asks a module through PROJECT_LANDINGS;
// nothing outside this file decides by what a computer is. Adding a road is a
// module and its row.
import { CLAUDE_CONFIG_DIR } from "@wsp/catalog";
import { INSTALL_MS, installScript, projectInstalls, type Machine } from "@wsp/engine";
import { claudeMemoryDir, NO_IMAGE_FOR_SEED, projectNeedsReaddLine, projectPathOn, projectRemovedAtProviderLine, projectRemovedHereLine, projectRemovedOnComputerLine, seedBytes, seedCommitsLandedLine, seedCommitsLostLine, SEED_DIR, SEED_MEMORY_DIR, SEED_PATCH, seedingLine, seedMemoryKeptLine, shellLine, shellQuote, type ExecResult, type MachineBind, type ProjectAddStage, type ProjectSource, type ProjectView, type SeedChoice, type SeedPlan } from "@wsp/protocol";
import type { ProjectSourceModule } from "./project-sources.js";

/** How far the add has got, as the door turns each one into an event. */
export type LandingReport = (stage: ProjectAddStage, message: string) => void;

/** Where one computer keeps a project: the checkout it clones into, on the computer itself where the computer
 * holds one outside its workspaces, and the memory folder every workspace of the project reads. */
export interface ProjectPlaces {
  /** Absent on a computer that keeps the checkout inside the image rather than on a disk of its own. */
  checkout?: string;
  memoryDir: string;
}

/** What the add hands a landing road: the record as it will be kept, the module that knows the source, the seed
 * archive where the source was a folder on this computer, and where to say how far it has got. */
export interface LandRequest {
  project: ProjectView;
  source: ProjectSourceModule;
  seed?: { tar: Buffer; choice: SeedChoice; plan: SeedPlan };
  report: LandingReport;
}

/** What one landing left behind, which the record keeps. */
export interface Landed {
  /** Where the checkout it cloned sits on the computer, for a road that keeps one outside its workspaces. */
  checkout?: string;
  seeded?: ProjectView["seeded"];
  installed?: ProjectView["installed"];
  image?: ProjectView["image"];
  /** One sentence about a step of the landing that failed on its own without failing the add: the commits the
   * remote has never seen, which stay on the person's own computer when git refuses them. */
  notice?: string;
}

/** What a landing road may ask of the runtime: a short-lived machine of the computer's own image to work in, the
 * road that puts a file's bytes on it, the snapshot a road that keeps an image takes, and the clock. */
export interface LandingDeps {
  /** A machine to work in on that computer. `from` is the image it forks, which the add read once, and is empty on
   * a computer that keeps no image, where the machine is a copy of that computer's own directories; `image` says
   * whether this machine's disk becomes one, which keeps the computer's own logins out of it. Killed by the caller
   * whatever happens. */
  worker(o: { binds: readonly MachineBind[]; image: boolean; from: string }): Promise<Machine>;
  /** Stops a worker once its work is done, resolving once the provider takes the ask; the read-back runs behind it. */
  stop(machine: Machine): Promise<void>;
  land(machine: Machine, path: string, bytes: Uint8Array): Promise<void>;
  checkpoint(machine: Machine, name: string): Promise<string>;
  /** Where wsp writes its own working files on that machine. */
  scratch(machine: Machine): string;
  /** Where the computer keeps project checkouts and each project's memory, as its own daemon says; absent from a
   * computer that keeps none, which is every provider. */
  projectsDir?: string;
  /** Where Claude Code keeps its projects on this Mac, for the road whose project is a folder here. */
  macStateHome: string;
  /** What this computer is called, since a record names it by its id and no sentence a person reads may. */
  computerName: string;
  /** The head of this host's own image, or nothing where it has sealed none: read by the road that forks one to
   * work in, and by no other, so a computer that forks nothing is never refused for want of an image. */
  imageHead(): Promise<string | undefined>;
  /** One command on the computer holding the project, outside every workspace of it: how the folder wsp keeps
   * there is taken away again. Absent on a computer that runs nothing of wsp's outside a workspace, which is this
   * Mac and every provider. */
  onComputer?(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  now(): number;
}

export interface ProjectLanding {
  /** What the computer is: a computer the person owns whose daemon holds the disk, a provider that keeps the
   * project in an image, or the computer the app runs on. */
  kind: "box" | "provider" | "mac";
  /** Where the checkout sits inside a workspace of this project: the folder rule is one for every computer and
   * the folder a cloned checkout sits under is this road's own, since it is the road that knows which folders a
   * workspace there can hold a copy at. */
  path(o: { name: string; source: ProjectSource }): string;
  places(o: { project: Pick<ProjectView, "id" | "name" | "path" | "source">; memoryKey: string; deps: LandingDeps }): ProjectPlaces;
  /** Whether the add itself does the work on this computer, or the record stands alone and the first workspace of
   * it clones inside its own copy. A seed is always the add's: it carries the person's own files, which only the
   * add has in hand. */
  landsAtAdd(o: { seeding: boolean }): boolean;
  land(o: LandRequest, deps: LandingDeps): Promise<Landed>;
  /** Why no workspace of this project can be made on this computer, or nothing where one can. Read before a
   * machine is asked for or a record written, so a project nothing can be made of leaves neither behind. */
  refusal(project: ProjectView, deps: LandingDeps): string | undefined;
  /** What dropping the record takes on this computer, and the one sentence the person reads for it. Only what the
   * add itself made there ever goes; nothing of the code is asked of a remote and nothing else on the computer is
   * touched. Run before the record goes, so a computer that cannot be reached keeps both. */
  remove(project: ProjectView, deps: LandingDeps): Promise<string>;
  /** The folders of the computer's own every workspace of this project mounts. */
  workspaceBinds(project: ProjectView): MachineBind[];
}

/** The folder a workspace on a computer the person owns holds a cloned checkout under. /srv is one of the five
 * trees such a workspace reads through an overlay of its own, so the mount point the copy is bound at lands in
 * that workspace's upper and goes when it goes; /root is the computer's own home, bound into every workspace of
 * it, where a bind would leave its mount point on the computer itself. */
const BOX_CHECKOUT_HOME = "/srv";
/** The folder a fork of an image holds its checkout under: its own login's home, shared with nothing. */
const FORK_CHECKOUT_HOME = "/root";
/** How every git line of the patch step is run on a computer that has no git identity of its own: wsp's own, since
 * git refuses to write a commit or a reflog entry without one. Not only the `git am`: the `git am --abort` that
 * puts a refused patch back needs one too, and a box where it failed for want of one left the checkout with a
 * patch half applied in it. The author every commit already carries is the person's and is never touched. */
const AS_WSP = ["-c", "user.name=wsp", "-c", "user.email=wsp@localhost"];

/** How long the clone gets on the computer. A repo of a few hundred megabytes over a box's own link is minutes. */
const CLONE_MS = 600_000;
/** How long the small steps get: the seed unpacked, the patch applied, the root listed. */
const STEP_MS = 120_000;

/** The lines every clone on a computer runs, in order: the check that the command the source clones through is
 * there at all, the line pointing git at that command's login, the folder above the checkout, and the clone. The
 * add reads them with a seed on top; a workspace whose own create clones reads them alone, so the two roads
 * cannot differ about what cloning a project means. */
export function cloneLines(o: { source: ProjectSourceModule; remote: string; checkout: string; computer: string; branch?: string }): string[] {
  const cli = o.source.cli;
  return [
    "set -e",
    // The command the clone goes through, before anything is made: a computer whose image does not carry it is
    // refused in one sentence naming the command, rather than a clone that sits waiting for a password.
    ...(cli === undefined ? [] : [`command -v ${cli.bin} >/dev/null 2>&1 || { echo ${shellQuote(cli.missing(o.computer))} >&2; exit 1; }`, cli.setupGit]),
    `mkdir -p ${shellQuote(o.checkout.replace(/\/[^/]+$/, ""))}`,
    o.source.cloneCommand({ remote: o.remote, dest: o.checkout, ...(o.branch !== undefined ? { branch: o.branch } : {}) }),
  ];
}

/** The clone with the person's ticked files unpacked on top of it, which is the add's own road. The commits and
 * the memory folder the seed carries are steps of their own, so a step git refuses fails what it was for and not
 * the add. */
export function cloneScript(o: { source: ProjectSourceModule; remote: string; checkout: string; computer: string; branch?: string; seedTar?: string }): string {
  const lines = cloneLines(o);
  if (o.seedTar !== undefined) lines.push(`tar -xzf ${shellQuote(o.seedTar)} -C ${shellQuote(o.checkout)}`);
  return lines.join("\n");
}

/** Which branch the seed's commits go on, where they started, and which branch the checkout is left on: the
 * person's own branch, made where their work started; `-B` and not `-b` since the branch may be one the remote
 * has, which the clone already made. */
export interface PatchStep {
  branch: string;
  base: string;
  back: string;
}

/** The step that puts the commits the remote has never seen on the checkout, with the count read back off git
 * itself as its last line.
 *
 * One command per line under `set -e`, never an `&&` chain: `-e` is exempt for every command of an AND list but
 * its last, so a chain whose `git am` failed stopped without ending the script and left the add saying the
 * commits had landed. */
export function patchScript(o: PatchStep & { checkout: string }): string {
  const at = ["git", "-C", o.checkout, ...AS_WSP];
  return [
    "set -e",
    shellLine([...at, "checkout", "-B", o.branch, o.base]),
    shellLine([...at, "am", "--3way", `${o.checkout}/${SEED_PATCH}`]),
    shellLine([...at, "checkout", o.back]),
    shellLine([...at, "rev-list", "--count", `${o.base}..${o.branch}`]),
  ].join("\n");
}

/** What runs when git refused the patch: the half-applied am put back, the branch the step made dropped, and the
 * branch the clone came up on set to the remote's own tip again, since the step moved it where the person's work
 * started. Every copy of this checkout then starts on the clone as it was.
 *
 * No `set -e` here and nothing read back: an abort with nothing in progress and a branch the step never made both
 * exit non-zero, and neither is a reason to fail an add that otherwise landed. */
export function patchCleanupScript(o: PatchStep & { checkout: string }): string {
  const at = ["git", "-C", o.checkout, ...AS_WSP];
  return [
    shellLine([...at, "am", "--abort"]),
    shellLine([...at, "checkout", "-f", o.back]),
    shellLine([...at, "reset", "--hard", `origin/${o.back}`]),
    ...(o.branch === o.back ? [] : [shellLine([...at, "branch", "-D", o.branch])]),
  ].join("\n");
}

/** What the memory step prints where the computer already keeps memory at the agent's path: read off the step's
 * own output, since the script is the only thing that sees what stands there. */
export const MEMORY_KEPT_MARK = "wsp-memory-kept";

/** What the remove prints where a memory folder for the project stands on the computer: the same road, since the
 * one command the remove runs there is the only thing that can see it. */
export const MEMORY_STANDS_MARK = "wsp-memory-stands";

/** The one command a remove runs on the computer: it says whether the agent there kept memory for this project,
 * which the sentence names only where it is true, and takes away wsp's own folder for the project. The read comes
 * first because the folder goes with the command; the memory is under the computer's own home and is never
 * touched by it. No `set -e`: a memory folder that is not there is the common case, not a failure. */
export function removeScript(o: { dir: string; memoryDir: string }): string {
  return [`[ -d ${shellQuote(o.memoryDir)} ] && echo ${shellQuote(MEMORY_STANDS_MARK)}`, `rm -rf ${shellQuote(o.dir)}`].join("\n");
}

/** The last of the seed: the memory folder moved out of the checkout onto the computer, where every workspace of
 * the project reads it, and wsp's own folder and the archive gone from the checkout every copy is taken of.
 *
 * What is kept at the memory path is memory, and no memory is ever removed. An empty folder there is nothing
 * kept: it is the mount point an older bind left on the computer, or the folder the agent makes before it writes
 * a line in it, so `rmdir` takes it and the seed's memory lands in its place. `rmdir` removes an empty directory
 * and nothing else, so it can never take a byte of what the agent wrote; whatever stands after it stays, and the
 * mark then says the seed's memory was not landed.
 *
 * One command per line, as `patchScript` is and for the same reason: `-e` is exempt for every command of an AND
 * list but its last, so a `mkdir` chained to the `mv` would skip the move and let the script run on to the sweep
 * below, which would take the seed's memory with the folder it came in. */
export function seedRestScript(o: { checkout: string; memoryDir: string; seedTar: string; memory: boolean }): string {
  const lines = ["set -e"];
  if (o.memory) {
    const memory = shellQuote(o.memoryDir);
    lines.push(
      `rmdir ${memory} 2>/dev/null || true`,
      `if [ -e ${memory} ]; then`,
      `  echo ${shellQuote(MEMORY_KEPT_MARK)}`,
      "else",
      `  mkdir -p ${shellQuote(o.memoryDir.replace(/\/[^/]+$/, ""))}`,
      `  mv ${shellQuote(`${o.checkout}/${SEED_MEMORY_DIR}`)} ${memory}`,
      "fi",
    );
  }
  lines.push(`rm -rf ${shellQuote(`${o.checkout}/${SEED_DIR}`)} ${shellQuote(o.seedTar)}`);
  return lines.join("\n");
}

/** The clone, the seed and the install on one machine, the half both roads that clone share. The install is read
 * off the checkout's own root: one listing, then the command the catalog's row for that lockfile names, once. */
async function cloneSeedInstall(
  o: LandRequest,
  deps: LandingDeps,
  machine: Machine,
  /** `checkout` is where the work runs inside the machine, which is the path the project has inside every
   * workspace of it; `holds` is where that folder sits on the computer once the machine is gone, which is what the
   * cloning line names, since a person watching an add is being told where their code landed on their computer. */
  places: { checkout: string; holds: string; memoryDir: string; log: string },
): Promise<Landed> {
  const { project, report } = o;
  const seed = o.seed;
  const seedTar = seed === undefined ? undefined : `${deps.scratch(machine)}/seed-${project.id}.tgz`;
  if (seed !== undefined && seedTar !== undefined) await deps.land(machine, seedTar, seed.tar);
  report("cloning", `Cloning ${project.remote} into ${places.holds}.`);
  const script = cloneScript({
    source: o.source,
    remote: project.remote,
    checkout: places.checkout,
    computer: deps.computerName,
    ...(project.base !== undefined ? { branch: project.base } : {}),
    ...(seedTar !== undefined ? { seedTar } : {}),
  });
  if (seed !== undefined) report("seeding", seedingLine(seed.plan, seed.choice));
  const ran = await machine.exec(script, { timeoutMs: CLONE_MS });
  if (ran.exitCode !== 0) throw new Error(lastLine(ran.stderr) ?? lastLine(ran.stdout) ?? `the clone exited ${ran.exitCode}`);
  const patched = seed === undefined ? undefined : await patchSeed({ seed, report, computerName: deps.computerName, checkout: places.checkout, base: project.base }, machine);
  let memoryKept = false;
  if (seed !== undefined && seedTar !== undefined) {
    const rest = await machine.exec(seedRestScript({ checkout: places.checkout, memoryDir: places.memoryDir, seedTar, memory: seed.choice.memory && seed.plan.memory !== null }), { timeoutMs: STEP_MS });
    if (rest.exitCode !== 0) throw new Error(lastLine(rest.stderr) ?? lastLine(rest.stdout) ?? `landing the seed exited ${rest.exitCode}`);
    // The memory that computer already kept for this project stayed, so the person is told rather than left to
    // find that the folder they seeded from is not what their agent reads there.
    memoryKept = rest.stdout.includes(MEMORY_KEPT_MARK);
    if (memoryKept) report("seeding", seedMemoryKeptLine(deps.computerName));
  }
  const memory = seed !== undefined && seed.choice.memory && seed.plan.memory !== null ? seed.plan.memory : undefined;
  const landed: Landed = {
    ...(seed === undefined
      ? {}
      : {
          seeded: {
            files: seed.choice.files.length,
            // The bytes the menu showed for the ticked files, which is what the person read before they said yes;
            // the archive they travelled in is bigger and says nothing about what landed.
            bytes: seedBytes(seed.plan, seed.choice),
            memory: memory === undefined ? "none" : memoryKept ? "kept" : "landed",
            ...(memory === undefined ? {} : { memoryFiles: memory.files }),
            // What the checkout itself has, read back off git rather than taken off the plan: a patch git refused
            // is nought commits on that computer whatever the person's own folder held.
            commits: patched?.commits ?? 0,
            at: new Date(deps.now()).toISOString(),
          },
          ...(patched?.notice !== undefined ? { notice: patched.notice } : {}),
        }),
  };
  const root = await machine.exec(`ls -A ${shellQuote(places.checkout)}`, { timeoutMs: STEP_MS });
  // Every ecosystem the checkout's own root names a lockfile for, in catalogue order: a repo that is a Node app
  // with a Rust crate in it gets both, and a repo no row names an install for gets none.
  const installs = projectInstalls(root.stdout.split("\n").map(name => name.trim()), places.checkout);
  if (installs.length === 0) return landed;
  const began = deps.now();
  for (const install of installs) {
    report("installing", `${install.command} in ${places.checkout}.`);
    const ok = await machine.exec(installScript(install, { dir: places.checkout, log: places.log }), { timeoutMs: INSTALL_MS });
    if (ok.exitCode !== 0) {
      const said = lastLine(ok.stderr) ?? lastLine(ok.stdout) ?? `exit ${ok.exitCode}`;
      throw new Error(`${install.command} in ${places.checkout}: ${said}; its whole output is ${places.log} on ${project.computer}`);
    }
  }
  return {
    ...landed,
    installed: {
      row: installs.map(i => i.row).join(", "),
      command: installs.map(i => i.command).join("; "),
      at: new Date(deps.now()).toISOString(),
      seconds: Math.round((deps.now() - began) / 1000),
    },
  };
}

/** The seed's commits put on the checkout, as its own step: the count git read back where they landed, and the
 * one sentence the person reads where git refused them. A refusal is not the add's failure; the commits are still
 * on their own computer, the checkout is put back to the clone as it was and the record says nought commits, so
 * what they are told and what is on the computer are the same thing. */
async function patchSeed(
  o: { seed: { choice: SeedChoice; plan: SeedPlan }; report: LandingReport; computerName: string; checkout: string; base?: string },
  machine: Machine,
): Promise<{ commits: number; notice?: string }> {
  const unpushed = o.seed.plan.unpushed;
  if (o.seed.choice.commits !== true || unpushed === null) return { commits: 0 };
  const step: PatchStep = { branch: o.seed.plan.branch, base: unpushed.base, back: await cloneBranch(o, machine) };
  const ran = await machine.exec(patchScript({ ...step, checkout: o.checkout }), { timeoutMs: STEP_MS });
  if (ran.exitCode === 0) {
    const counted = Number(lastLine(ran.stdout));
    // What landed, said after what travelled: the count git read off the checkout, which is nought where that
    // computer's clone already had the person's work. A refusal says it did not land and is said once, below.
    if (Number.isInteger(counted)) {
      o.report("seeding", seedCommitsLandedLine(counted));
      return { commits: counted };
    }
  }
  // The cleanup's own exit is not read: what it could not do (an abort with nothing in progress, a branch the
  // step never made) is no reason to fail an add whose clone and install landed.
  await machine.exec(patchCleanupScript({ ...step, checkout: o.checkout }), { timeoutMs: STEP_MS });
  const said = lastLine(ran.stderr) ?? lastLine(ran.stdout) ?? `git exited ${ran.exitCode}`;
  const notice = seedCommitsLostLine(unpushed.commits, step.branch, o.computerName, said, step.back);
  o.report("seeding", notice);
  return { commits: 0, notice };
}

/** The branch the clone came up on, read off the checkout itself: what the patch step leaves the checkout on and
 * what its failure road resets to the remote's tip. Read rather than taken off the plan, because the plan's own
 * branch is the person's, which the remote may never have seen: `origin/<that>` is then no ref at all and the
 * reset would be a silent no-op leaving the checkout where the step moved it. The clone is always on a branch the
 * remote has. `symbolic-ref` and not `rev-parse --abbrev-ref`: it says the branch in one line and exits non-zero
 * on a detached head rather than answering the word HEAD. The plan's words are the fallback for a checkout that
 * answers neither. */
async function cloneBranch(o: { seed: { plan: SeedPlan }; checkout: string; base?: string }, machine: Machine): Promise<string> {
  const read = await machine.exec(shellLine(["git", "-C", o.checkout, "symbolic-ref", "--short", "HEAD"]), { timeoutMs: STEP_MS });
  const on = read.exitCode === 0 ? lastLine(read.stdout) : undefined;
  return on ?? o.base ?? o.seed.plan.defaultBranch ?? o.seed.plan.branch;
}

/** A computer the person owns: its daemon holds the disk, so the checkout sits on that disk under wsp's own folder
 * for the project. The memory sits where the agent on that computer already reads it, in the agent's own state
 * home under the computer's home, and no workspace binds it: that home is the computer's own inside every
 * workspace of it, so the memory is already at the path each of them reads, and a mount point made under that
 * home would be left on the computer once the workspace was gone. The clone, the seed and the install run inside
 * one short-lived workspace of that computer, with wsp's folder for the project bound in, so the toolchain and
 * the logins are the ones its workspaces run with and nothing of wsp's is installed on the computer itself. */
const boxLanding: ProjectLanding = {
  kind: "box",
  path: ({ source, name }) => projectPathOn(source, name, BOX_CHECKOUT_HOME),
  places({ project, memoryKey, deps }) {
    return { checkout: `${projectDir(deps, project.id)}/checkout`, memoryDir: guestMemoryDir(memoryKey) };
  },
  // Every project here is cloned once by the add, however it was named: a repo the computer could clone at each
  // create would be cloned into the same folder twice and would leave that folder behind when the project goes.
  landsAtAdd: () => true,
  refusal: (project, deps) => (project.checkout === undefined ? projectNeedsReaddLine(project.name, deps.computerName, project.source) : undefined),
  async remove(project, deps) {
    const dir = removableProjectDir(deps, project.id);
    const ran = await onComputer(deps)(removeScript({ dir, memoryDir: project.memoryDir }), { timeoutMs: STEP_MS });
    return projectRemovedOnComputerLine(project.name, deps.computerName, dir, ran.stdout.includes(MEMORY_STANDS_MARK));
  },
  async land(o, deps) {
    const dir = projectDir(deps, o.project.id);
    const checkout = `${dir}/checkout`;
    // Two folders of the computer's own, bound into the machine that does the work: wsp's own folder for the
    // project at its own path, so the install's log lands on the computer and stays there once the machine is
    // gone; and the checkout at the path the project has inside every workspace of it, so the clone and the
    // install run where the workspaces will read them. An install that writes an absolute path (a virtualenv's
    // own shebangs, its pyvenv.cfg) then names the path the workspaces have rather than the folder the computer
    // keeps the checkout in. The memory needs no bind: the machine's home is the computer's own, so the seed's
    // memory lands where the agent on it reads this project.
    const binds = [
      { source: dir, target: dir },
      { source: checkout, target: o.project.path },
    ];
    // A computer that keeps no image is worked in a copy of its own directories: nothing of this host's is forked
    // here, which is why no image is read on this road at all.
    const machine = await deps.worker({ binds, image: false, from: "" });
    let failed: unknown;
    try {
      // The checkout stays on the computer once the machine is gone: every workspace of this project takes its own
      // copy of it, so the seed and the install are paid for once.
      return { checkout, ...(await cloneSeedInstall(o, deps, machine, { checkout: o.project.path, holds: checkout, memoryDir: o.project.memoryDir, log: `${dir}/install.log` })) };
    } catch (e) {
      failed = e;
      throw e;
    } finally {
      await deps.stop(machine).catch((e: unknown) => console.warn(`the machine that added ${o.project.name} was not stopped: ${e instanceof Error ? e.message : String(e)}`));
      // Nothing of a project that was not recorded is left on the computer: the folder the bind made goes, so the
      // add can be run again under the same name and nothing of it sits on that disk unowned. After the machine is
      // stopped and never before: those folders are its binds' own sources while it runs, and what Linux makes of
      // a source removed under a live container is not a question to open for a sweep that can wait a second.
      if (failed !== undefined) {
        const swept = removableProjectDir(deps, o.project.id);
        await onComputer(deps)(`rm -rf ${shellQuote(swept)}`, { timeoutMs: STEP_MS }).catch((swallow: unknown) =>
          console.warn(`${swept} on ${deps.computerName} was not swept after the add of ${o.project.name} failed: ${swallow instanceof Error ? swallow.message : String(swallow)}`),
        );
      }
    }
  },
  workspaceBinds: () => [],
};

/** A provider: nothing of the project sits on a disk of this person's there, so the clone, the seed and the
 * install run on a fork of the image and that machine is snapshotted as the project's image. Every workspace of
 * the project forks that image, which carries the memory as it was when the image was built and diverges from
 * there; there is nothing to bind. */
const providerLanding: ProjectLanding = {
  kind: "provider",
  path: ({ source, name }) => projectPathOn(source, name, FORK_CHECKOUT_HOME),
  places({ memoryKey }) {
    return { memoryDir: guestMemoryDir(memoryKey) };
  },
  // Only a seed lands here: it carries the person's own files, which only the add has. A repo this computer can
  // clone by itself is recorded and cloned inside the workspace's own copy, where the clone leaves nothing behind
  // because the copy is the machine.
  landsAtAdd: ({ seeding }) => seeding,
  refusal: () => undefined,
  async remove(project, deps) {
    return projectRemovedAtProviderLine(project.name, deps.computerName, project.image?.snapshotId);
  },
  async land(o, deps) {
    // The seed lands inside a copy of this host's own image, so a host that has sealed none has nowhere to put it.
    const from = await deps.imageHead();
    if (from === undefined) throw Object.assign(new Error(NO_IMAGE_FOR_SEED), { kind: "invalid" });
    // A builder: its disk becomes an image, and a sign-in never sits in one.
    const machine = await deps.worker({ binds: [], image: true, from });
    try {
      const landed = await cloneSeedInstall(o, deps, machine, { checkout: o.project.path, holds: o.project.path, memoryDir: guestMemoryDir(o.project.memoryKey), log: `${deps.scratch(machine)}/install-${o.project.id}.log` });
      o.report("imaging", `Sealing ${o.project.name} as the image every workspace of it forks.`);
      const snapshotId = await deps.checkpoint(machine, `${o.project.name}-${o.project.id}`);
      return { ...landed, image: { snapshotId, builtAt: new Date(deps.now()).toISOString() } };
    } finally {
      await deps.stop(machine).catch((e: unknown) => console.warn(`the machine that built the image for ${o.project.name} was not stopped: ${e instanceof Error ? e.message : String(e)}`));
    }
  },
  workspaceBinds: () => [],
};

/** The computer the app runs on: the person's own folder is the project, so nothing is cloned, seeded or
 * installed, and the memory folder is the one Claude Code already keeps for that folder here. */
const macLanding: ProjectLanding = {
  kind: "mac",
  // A repo is refused on this computer before a road is asked for it, so the folder rule is the whole rule here
  // and this road names no folder for a checkout it would never hold.
  path: ({ source, name }) => projectPathOn(source, name),
  places({ project, memoryKey, deps }) {
    return { checkout: project.source.kind === "folder" ? project.source.path : project.path, memoryDir: claudeMemoryDir(deps.macStateHome, memoryKey) };
  },
  landsAtAdd: () => false,
  refusal: () => undefined,
  async remove(project) {
    return projectRemovedHereLine(project.name);
  },
  async land() {
    return {};
  },
  workspaceBinds: () => [],
};

export const PROJECT_LANDINGS: ReadonlyMap<ProjectLanding["kind"], ProjectLanding> = new Map([
  [boxLanding.kind, boxLanding],
  [providerLanding.kind, providerLanding],
  [macLanding.kind, macLanding],
]);

/** The road one computer's project lands by, or the wiring fault of a kind nothing registered. */
export function projectLanding(kind: ProjectLanding["kind"]): ProjectLanding {
  const found = PROJECT_LANDINGS.get(kind);
  if (found === undefined) throw new Error(`no project landing road for ${kind}`);
  return found;
}

/** Where Claude Code reads a project's memory inside every workspace: its own state home on the guest, keyed by
 * the project's key rather than by the path the checkout happens to sit at. */
export const guestMemoryDir = (memoryKey: string): string => claudeMemoryDir(CLAUDE_CONFIG_DIR, memoryKey);

/** Where the computer keeps this project, under the folder its own daemon says it keeps project checkouts in. A
 * computer that names none cannot hold a project this way, which is a wiring fault rather than a person's road. */
function projectDir(deps: LandingDeps, projectId: string): string {
  return `${projectsDir(deps)}/${projectId}`;
}

/** The one folder a remove or a failed add takes on the computer, read before it is ever spelled into an
 * `rm -rf`: wsp's own folder for that project, one segment under the projects directory the computer's daemon
 * named, named by an id wsp minted itself. No word a person typed is ever part of it, and a path of any other
 * shape is a wiring fault that removes nothing. */
function removableProjectDir(deps: LandingDeps, projectId: string): string {
  const under = projectsDir(deps);
  const dir = `${under}/${projectId}`;
  if (!under.startsWith("/") || !/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error(`${dir} is not wsp's own folder for a project under ${under}, so nothing was removed`);
  return dir;
}

/** The road one command on the computer itself takes, or the wiring fault of a computer that holds a project's
 * folder and runs nothing outside its workspaces. */
function onComputer(deps: LandingDeps): NonNullable<LandingDeps["onComputer"]> {
  if (deps.onComputer === undefined) throw new Error("that computer runs nothing of wsp's outside its workspaces, so the folder wsp keeps for a project there cannot be taken away");
  return deps.onComputer;
}

function projectsDir(deps: LandingDeps): string {
  if (deps.projectsDir === undefined) throw new Error("that computer's daemon does not say where it keeps project checkouts, so nothing can be cloned there");
  return deps.projectsDir.replace(/\/+$/, "");
}

const lastLine = (out: string): string | undefined => {
  const line = out.trim().split("\n").at(-1)?.trim();
  return line === undefined || line === "" ? undefined : line;
};
