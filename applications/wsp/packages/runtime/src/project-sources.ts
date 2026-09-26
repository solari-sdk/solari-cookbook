// SPDX-License-Identifier: AGPL-3.0-only
// The project sources as modules, one per kind: what a source resolves to on
// this computer (the remote the other computer clones and the project's own
// name), the line that clones it there, and the command that clone goes
// through where it goes through one rather than through git. The add asks a
// module through PROJECT_SOURCES; nothing outside this file decides by a
// source's kind. Adding a source is a module and its row.
import { GIT_HOSTS, gitHostOf, noGitCliLine, ownerRepoOf, type GitHost } from "@wsp/catalog";
import { noRemoteLine, projectNameOf, shellLine, type ProjectSource, type SeedPlan } from "@wsp/protocol";

/** What a source resolved to on this computer: the remote whichever computer holds the project will clone, the
 * branch its HEAD names, the project's own name, and the seed menu where the source is a folder here. */
export interface ResolvedSource {
  remote: string;
  defaultBranch: string;
  name: string;
  /** Only a folder on this computer has one; every other source is a repo the computer clones and seeds nothing. */
  seed?: SeedPlan;
}

/** What a module may ask of this computer while it resolves: whether the project is being seeded onto a computer
 * that clones, the seed menu for that road, and the one cheap read of a folder's own remote for the road that
 * works it where it sits. */
export interface SourceDeps {
  /** True where the folder seeds a project on another computer, which is the one road that reads the whole menu. */
  seeding: boolean;
  seedPlan(folder: string): Promise<SeedPlan>;
  /** A folder's origin and the branch that remote's HEAD names, read with one command; both empty where it has none. */
  folderRemote(folder: string): Promise<{ remote: string; defaultBranch: string }>;
}

export interface ProjectSourceModule<S extends ProjectSource = ProjectSource> {
  kind: S["kind"];
  /** The remote this source names on its own, without asking this computer anything: a repo's own url, the https
   * url a host's owner/repo is, and nothing for a folder, whose remote only its own git can say. */
  remote(source: S): string;
  resolve(source: S, deps: SourceDeps): Promise<ResolvedSource>;
  /** The line that clones the project onto the computer that holds it, in that computer's own shell. */
  cloneCommand(o: { remote: string; dest: string; branch?: string }): string;
  /** The command on the computer the clone goes through, where it goes through one rather than through git: the
   * word the image carries it as, the line that points git at its login, and the sentence a computer whose image
   * has none is refused with. The landing checks the word is there before it clones, so a missing sign-in is one
   * sentence naming the command rather than a clone waiting for a password no box can answer. */
  cli?: { bin: string; setupGit: string; missing: (computer: string) => string };
}

/** The clone every source but a host's own command line takes: git itself, at the branch the record names when it
 * names one, so a fork starts on the branch the project was recorded with. */
const gitClone = (o: { remote: string; dest: string; branch?: string }): string =>
  shellLine(["git", "clone", ...(o.branch !== undefined ? ["--branch", o.branch] : []), o.remote, o.dest]);

/** The default branch a remote's HEAD names, as the clone will take it: `main` where nothing could be read, which
 * is what git itself falls back to and what the record then carries. */
export const DEFAULT_BRANCH = "main";
/** A branch read off a folder or a remote, or that fallback where the read came back empty. */
const branchOr = (read: string | undefined): string => (read === undefined || read === "" ? DEFAULT_BRANCH : read);

const folderModule: ProjectSourceModule<Extract<ProjectSource, { kind: "folder" }>> = {
  kind: "folder",
  remote: () => "",
  // A folder on this computer is not carried anywhere: the computer clones the folder's own origin and the folder
  // seeds what git ignores on top of that clone. A folder git has no remote for is refused here, before anything
  // is created, since there would be nothing for the other computer to clone.
  async resolve(source, deps) {
    // A folder worked where it sits is cloned nowhere, so nothing of it is read beyond its own remote: the whole
    // menu is for the road that carries what git ignores onto another computer.
    if (!deps.seeding) {
      const { remote, defaultBranch } = await deps.folderRemote(source.path);
      return { remote, defaultBranch: branchOr(defaultBranch), name: projectNameOf(source) };
    }
    const seed = await deps.seedPlan(source.path);
    if (seed.remote === null) throw Object.assign(new Error(noRemoteLine(source.path)), { kind: "invalid" });
    // An ssh remote is recorded as its host's https url: no box carries an ssh key of the person's, so the remote
    // as it stands would ask for one, and over https the host's own signed-in command line answers for it.
    const host = gitHostOf(seed.remote);
    const ownerRepo = host === undefined ? undefined : ownerRepoOf(seed.remote);
    const remote = host !== undefined && ownerRepo !== undefined && !seed.remote.startsWith("https://") ? host.httpsUrl(ownerRepo) : seed.remote;
    return { remote, defaultBranch: branchOr(seed.defaultBranch ?? seed.branch), name: projectNameOf(source), seed };
  },
  cloneCommand: gitClone,
};

const gitModule: ProjectSourceModule<Extract<ProjectSource, { kind: "git" }>> = {
  kind: "git",
  remote: source => source.url,
  async resolve(source) {
    return { remote: gitModule.remote(source), defaultBranch: DEFAULT_BRANCH, name: projectNameOf(source) };
  },
  cloneCommand: gitClone,
};

/** The two hosts whose signed-in command line the image carries, as source modules: the clone goes through that
 * command, which reads the login on the computer rather than asking for a credential no box holds. A computer
 * whose image has no such login is refused by name, so nothing waits inside a clone for a password. */
function hostModule(host: GitHost): ProjectSourceModule<Extract<ProjectSource, { kind: "github" | "gitlab" }>> {
  return {
    kind: host.id,
    remote: source => host.httpsUrl(source.repo),
    async resolve(source) {
      return { remote: host.httpsUrl(source.repo), defaultBranch: DEFAULT_BRANCH, name: projectNameOf(source) };
    },
    // The command line takes owner/repo, which the https url the record keeps is read back to: one word on the
    // record, and the clone the host's own command makes of it.
    cloneCommand: o => host.clone(ownerRepoOf(o.remote) ?? o.remote, o.dest),
    cli: { bin: host.cli, setupGit: host.setupGit, missing: computer => noGitCliLine(host, computer) },
  };
}

export const PROJECT_SOURCES: ReadonlyMap<ProjectSource["kind"], ProjectSourceModule> = new Map<ProjectSource["kind"], ProjectSourceModule>([
  [folderModule.kind, folderModule as ProjectSourceModule],
  [gitModule.kind, gitModule as ProjectSourceModule],
  ...GIT_HOSTS.map(host => [host.id, hostModule(host) as ProjectSourceModule] as const),
]);

/** The remote one source names, read through its own module: what a record written before it carried one is
 * filled in with, and what the add records. */
export const projectRemote = (source: ProjectSource): string => projectSource(source.kind).remote(source);

/** The module for one source, or the wiring fault of a kind nothing registered. */
export function projectSource(kind: ProjectSource["kind"]): ProjectSourceModule {
  const found = PROJECT_SOURCES.get(kind);
  if (found === undefined) throw new Error(`no project source module for ${kind}`);
  return found;
}
