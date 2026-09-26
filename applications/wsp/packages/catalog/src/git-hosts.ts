// SPDX-License-Identifier: AGPL-3.0-only
// One row per git host whose signed-in command line the image carries. A
// computer clones a private repo through that command's own credential
// helper, since no box holds an ssh key of the person's; the row says which
// command, how it is pointed at git, how its sign-in is read and which ssh
// host names mean it. Adding a host is adding a row.

export interface GitHost {
  id: "github" | "gitlab";
  /** The command the image carries, signed in once per computer. */
  cli: string;
  /** The ssh host names this host's remotes use: an ssh remote naming one of them is cloned over https through the
   * command's credential helper, since a box carries no ssh key of the person's. */
  sshHosts: readonly string[];
  httpsUrl(ownerRepo: string): string;
  /** The line that makes git on the computer use the command's login. */
  setupGit: string;
  /** The line that says whether the command is signed in on the computer. */
  status: string;
  /** The line that clones through the command, which reads the login rather than a remote's own credentials. */
  clone(ownerRepo: string, dest: string): string;
}

export const GIT_HOSTS: readonly GitHost[] = [
  {
    id: "github",
    cli: "gh",
    sshHosts: ["github.com", "ssh.github.com"],
    httpsUrl: ownerRepo => `https://github.com/${ownerRepo}.git`,
    setupGit: "gh auth setup-git",
    status: "gh auth status",
    clone: (ownerRepo, dest) => `gh repo clone ${ownerRepo} ${dest}`,
  },
  {
    id: "gitlab",
    cli: "glab",
    sshHosts: ["gitlab.com", "altssh.gitlab.com"],
    httpsUrl: ownerRepo => `https://gitlab.com/${ownerRepo}.git`,
    setupGit: "glab auth git-credential",
    status: "glab auth status",
    clone: (ownerRepo, dest) => `glab repo clone ${ownerRepo} ${dest}`,
  },
];

/** The row an id names, or nothing where no row does. */
export const gitHost = (id: string): GitHost | undefined => GIT_HOSTS.find(h => h.id === id);

/** The host a remote's own URL belongs to, or nothing: an https or ssh remote naming one of a row's ssh host names
 * is that host's, whatever form it was written in. Read where a folder's origin is an ssh remote no box can open,
 * so the clone goes through that host's signed-in command instead. */
export function gitHostOf(remote: string): GitHost | undefined {
  const host = remote.replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "").split(/[/:]/)[0]?.toLowerCase();
  return host === undefined ? undefined : GIT_HOSTS.find(h => h.sshHosts.includes(host));
}

/** The `owner/repo` an https or ssh remote of a known host names, or nothing where the remote names no path. */
export function ownerRepoOf(remote: string): string | undefined {
  const path = remote.replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "").replace(/\.git$/, "").split(/[/:]/).slice(1).join("/");
  return path === "" ? undefined : path;
}

/** Why a source this computer's image has no signed-in command for records nothing: the clone would be asked for a
 * password no box can answer, so the refusal names the command and the computer rather than failing inside a clone. */
export const noGitCliLine = (host: GitHost, computer: string): string =>
  `${computer} has no ${host.cli} signed in, and a ${host.id} repo is cloned there through it; sign ${host.cli} in on that computer's image, or give the repo's https url`;
