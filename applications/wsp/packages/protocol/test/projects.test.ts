// SPDX-License-Identifier: AGPL-3.0-only
// What one word to wsp add names, what a project is called, where its
// checkout sits inside a workspace of it, and which workspace a folder on
// this computer belongs to: the command line, the runtime and the app all
// read these here.
import { describe, expect, it } from "vitest";
import { addedProjectLine, addedProjectOn, addingProjectLine, ADD_FORMS_LINE, projectSourceOf, computerNamed, folderName, HERE_PLACE_ID, hiddenFolder, isMacMachine, goldenForkName, homeShortened, kindWords, landsOn, MEMORY_KEPT_CLAUSE, noWorkspaceForFolderLine, NOT_A_REPO_LINE, ProjectGolden, projectNameOf, projectPathOn, projectRemovedOnComputerLine, projectsInPlace, type ProjectSource, type ProjectView, REGISTERING_LINE, registeredLine, registerTakesNoConsentLine, sameSourceRefusal, sourceKind, threadOpenedLine, workspaceForFolder, workspaceLands, type WorkspaceProject, WorkspaceView } from "../src/index.js";

const spoo: WorkspaceProject = { name: "spoo", dest: "/root/spoo", importedAt: "2026-09-01T00:00:00Z", size: 1024 };
const wsp: WorkspaceProject = { name: "wsp", dest: "/root/wsp", importedAt: "2026-09-02T00:00:00Z" };
const ref = { id: "pr_1a2b3c4d", name: "spoo-landing", path: "/root/spoo-landing", computer: "pl_box" };
const view = { id: "ws_1", name: "b2", machineId: "m1", phase: "running", golden: "snap_g", createdAt: "2026-09-06T09:00:00.000Z", project: ref };

const folderSource = (path: string): ProjectSource => ({ kind: "folder", path });
const gitSource = (url: string): ProjectSource => ({ kind: "git", url });

const project = (over: Partial<ProjectView>): ProjectView => ({
  id: "pr_1",
  name: "wsp",
  computer: "here",
  source: folderSource("/Users/dev/wsp"),
  path: "/Users/dev/wsp",
  remote: "https://github.com/dev/wsp.git",
  defaultBranch: "main",
  memoryKey: "-Users-dev-wsp",
  memoryDir: "/Users/dev/.claude/projects/-Users-dev-wsp/memory",
  createdAt: "2026-09-17T00:00:00.000Z",
  ...over,
});

describe("what one word to wsp add names", () => {
  it("a login is a computer, a url or a repo path is a repo, a path is a folder, and anything else is refused with the three forms", () => {
    expect(sourceKind("root@spoo")).toBe("computer");
    expect(sourceKind("root@178.156.161.168")).toBe("computer");
    expect(sourceKind("git@github.com:spoo-me/frontend.git")).toBe("git");
    expect(sourceKind("https://github.com/spoo-me/frontend")).toBe("git");
    expect(sourceKind("spoo-me/frontend.git")).toBe("git");
    expect(sourceKind("/Users/dev/wsp")).toBe("folder");
    expect(sourceKind("~/spoo/spoo-landing")).toBe("folder");
    expect(sourceKind("./frontend")).toBe("folder");
    // A path is a path first: a folder somebody called repo.git is theirs on this computer, not a url.
    expect(sourceKind("/Users/me/repo.git")).toBe("folder");
    expect(() => sourceKind("spoo")).toThrow(ADD_FORMS_LINE);
    // owner/repo is the word the host's own command line takes; the host in front of it names the other host.
    expect(sourceKind("spoo-me/frontend")).toBe("github");
    expect(sourceKind("gitlab.com/dev/thing")).toBe("gitlab");
    // The record keeps the word that command reads: no host in front of it and no .git after it.
    expect(projectSourceOf("gitlab.com/dev/thing.git", "gitlab")).toEqual({ kind: "gitlab", repo: "dev/thing" });
    expect(projectSourceOf("spoo-me/frontend", "github")).toEqual({ kind: "github", repo: "spoo-me/frontend" });
  });

  it("a project is named by its repo's last word without .git, or by the folder's own name", () => {
    expect(projectNameOf(gitSource("https://github.com/spoo-me/frontend.git"))).toBe("frontend");
    expect(projectNameOf(gitSource("https://github.com/spoo-me/frontend"))).toBe("frontend");
    expect(projectNameOf(gitSource("git@github.com:spoo-me/frontend.git"))).toBe("frontend");
    expect(projectNameOf(folderSource("/Users/z/spoo/spoo-landing"))).toBe("spoo-landing");
    expect(projectNameOf(folderSource("/Users/z/spoo/spoo-landing/"))).toBe("spoo-landing");
  });

  it("the checkout sits under the folder the landing road names, and a folder of yours is worked where it sits", () => {
    expect(projectPathOn(gitSource("https://github.com/spoo-me/frontend"), "spoo-landing", "/srv")).toBe("/srv/spoo-landing");
    expect(projectPathOn(gitSource("https://github.com/spoo-me/frontend"), "spoo-landing", "/root")).toBe("/root/spoo-landing");
    // A folder is its own path whatever the road says, which is why the road that clones nothing names no folder.
    expect(projectPathOn(folderSource("/Users/z/spoo/spoo-landing"), "spoo-landing")).toBe("/Users/z/spoo/spoo-landing");
    // And a repo on such a computer is a wiring fault, refused before any path is spelled for it.
    expect(() => projectPathOn(gitSource("https://github.com/spoo-me/frontend"), "spoo-landing")).toThrow("holds no checkout of its own");
  });

  it("which sources a computer takes is its kind's own row, so no road decides it for itself", () => {
    // A computer that clones takes a repo any of the three ways it can be named, and a folder on this computer,
    // which it clones from that folder's own remote and seeds what git ignores onto.
    expect(kindWords("local").projectSources).toEqual(["folder"]);
    expect(kindWords("cloud").projectSources).toEqual(["git", "github", "gitlab", "folder"]);
    expect(kindWords("ssh").projectSources).toEqual([]);
    // Copying the folder beside itself is its own word: a computer that clones takes a folder as a source and
    // still holds a checkout of it, so the two cannot be read off one list.
    expect([kindWords("local").copiesFolder, kindWords("cloud").copiesFolder, kindWords("ssh").copiesFolder]).toEqual([true, false, false]);
  });

  it("the refusals name the project, the folder and the computer", () => {
    expect(sameSourceRefusal("spoo-landing", "spoo")).toBe("that source is already a project on spoo, spoo-landing; one source on one computer is one project");
    expect(NOT_A_REPO_LINE).toBe("is not a git repo; git init makes it one, or name a repo's url with --on <computer>");
  });
});

describe("the project a workspace holds", () => {
  it("a workspace view carries exactly one project; a view with none, and one still carrying the old list, is not a view", () => {
    expect(WorkspaceView.parse(view)).toEqual(view);
    const { project: _dropped, ...noProject } = view;
    expect(WorkspaceView.safeParse(noProject).success).toBe(false);
    expect(WorkspaceView.safeParse({ ...noProject, projects: [spoo, wsp] }).success).toBe(false);
    // A view that carries both does not carry the list on: one stored home per fact, and the wire says so.
    expect("projects" in WorkspaceView.parse({ ...view, projects: [spoo] })).toBe(false);
  });

  it("a view carries the kind's own folder where the kind names one, the last branch of the rule, so a client shows the folder the runtime will open rather than guessing it", () => {
    expect(WorkspaceView.parse({ ...view, kind: "local", folder: "/Users/dev/wsp-work" })).toEqual({ ...view, kind: "local", folder: "/Users/dev/wsp-work" });
    expect(WorkspaceView.parse(view)).not.toHaveProperty("folder");
  });

  it("a view carries the machine's home where the kind knows it, so a client shortens a folder under it to ~ the way the machine's own shell would", () => {
    expect(WorkspaceView.parse({ ...view, home: "/root" })).toEqual({ ...view, home: "/root" });
    expect(WorkspaceView.parse(view)).not.toHaveProperty("home");
    expect(homeShortened("/root/spoo", "/root")).toBe("~/spoo");
    expect(homeShortened("/root", "/root")).toBe("~");
    expect(homeShortened("/rooted/spoo", "/root")).toBe("/rooted/spoo");
    expect(homeShortened("/root/spoo", undefined)).toBe("/root/spoo");
  });
});

describe("what a computer is called in a row", () => {
  it("is this computer's own word for the computer the host runs on, and the name this wsp holds for every other", () => {
    const named = new Map([["pl_box", "hetzner"]]);
    expect(computerNamed(HERE_PLACE_ID, named, "darwin")).toBe("this Mac");
    expect(computerNamed(HERE_PLACE_ID, named, "linux")).toBe("this computer");
    expect(computerNamed("pl_box", named, "linux")).toBe("hetzner");
    // A caller that could not read the list says the id rather than inventing a name for it.
    expect(computerNamed("pl_box", undefined, "darwin")).toBe("pl_box");
  });

  it("the line a recorded project answers with names the computer the same way, and says the command that makes its workspace", () => {
    const project = {
      id: "pr_1",
      name: "spoo-landing",
      computer: "pl_box",
      source: { kind: "git" as const, url: "https://github.com/dev/spoo.git" },
      path: "/root/spoo-landing",
      remote: "https://github.com/dev/spoo.git",
      defaultBranch: "main",
      memoryKey: "-root-spoo-landing",
      memoryDir: "/var/lib/wsp/projects/pr_1/memory",
      createdAt: "t",
    };
    expect(addedProjectLine(project, new Map([["pl_box", "hetzner"]]), "darwin")).toBe(
      'spoo-landing pr_1: https://github.com/dev/spoo.git on hetzner, at /root/spoo-landing inside a workspace of it\nmake one with: wsp new \'spoo-landing\' "<what you are working on>"',
    );
    // This computer's own word is the host's platform's, never a default: a line written on a Linux host says
    // this computer where a Mac says this Mac, and neither reads the other's word.
    const here = { ...project, id: "pr_2", name: "wsp", computer: HERE_PLACE_ID, source: { kind: "folder" as const, path: "/Users/dev/wsp" }, path: "/Users/dev/wsp" };
    expect(addedProjectLine(here, new Map(), "darwin")).toContain("on this Mac, at /Users/dev/wsp");
    expect(addedProjectLine(here, new Map(), "linux")).toContain("on this computer, at /Users/dev/wsp");
    // The add's own stage says that one sentence and no other: a caller holding the computer's word already,
    // which is the road the landing takes, reads the same line off it.
    expect(addedProjectOn(project, "hetzner")).toBe(addedProjectLine(project, new Map([["pl_box", "hetzner"]]), "darwin"));
  });

  it("the line the add starts with says what is being recorded and from where, and counts nothing it carries", () => {
    const folder: ProjectSource = { kind: "folder", path: "/Users/dev/spoo-landing" };
    // A seed travels with it, so what travels is the seeding's own line in the menu's counts and this one says
    // none of it: a count of ticked files here read as the whole of a seed carrying a memory folder too.
    expect(addingProjectLine("spoo-landing", folder, true)).toBe("spoo-landing from /Users/dev/spoo-landing.");
    // Nothing of the person's folder goes with a repo the computer clones itself, which nothing else says.
    expect(addingProjectLine("spoo-ts", { kind: "git", url: "https://github.com/dev/spoo.git" }, false)).toBe("spoo-ts from https://github.com/dev/spoo.git, nothing seeded.");
  });

  it("the remove on a computer you own names the memory kept there only where a folder of it stands", () => {
    // The clause has one home, which the tool describing the remove reads too.
    expect(MEMORY_KEPT_CLAUSE).toBe("the memory its agent keeps on that computer stays");
    expect(projectRemovedOnComputerLine("spoo-landing", "spoo", "/wsp/projects/pr_1", true)).toBe(
      "spoo-landing is no longer a project on spoo; the folder wsp kept for it there, /wsp/projects/pr_1, is gone with its checkout, and the memory its agent keeps on that computer stays",
    );
    // No agent ever ran there, so there is no memory on that computer to say anything about and the sentence
    // ends at the checkout rather than naming a folder that is not there.
    expect(projectRemovedOnComputerLine("spoo-landing", "spoo", "/wsp/projects/pr_1", false)).toBe(
      "spoo-landing is no longer a project on spoo; the folder wsp kept for it there, /wsp/projects/pr_1, is gone with its checkout",
    );
  });
});

describe("getting a project onto a machine", () => {
  it("a register says nothing was copied, and the flags a copy takes have no meaning here", () => {
    expect(REGISTERING_LINE).toBe("already on this computer, registering");
    expect(registeredLine("/Users/dev/wsp")).toBe("wsp registered at /Users/dev/wsp; nothing was copied.");
    expect(registerTakesNoConsentLine(["--keep"])).toBe("--keep has no meaning on this computer: the folder is registered at its path and nothing is carried, cut or replaced");
    expect(registerTakesNoConsentLine(["keep", "agents"])).toBe("keep, agents have no meaning on this computer: the folder is registered at its path and nothing is carried, cut or replaced");
    expect(folderName("/Users/dev/wsp/")).toBe("wsp");
    expect(folderName("wsp")).toBe("wsp");
  });

  it("a folder browser hides the machine's own folders: the dot-named ones anywhere, and a Mac home's own Library", () => {
    const mac = { home: "/Users/dev", mac: true };
    // A dot-named folder is the machine's own wherever it sits, and with nothing known about the machine at all.
    expect(hiddenFolder("/Users/dev/.config", mac)).toBe(true);
    expect(hiddenFolder("/root/.wsp")).toBe(true);
    expect(hiddenFolder("/Users/dev/code", mac)).toBe(false);
    // The Library the Mac keeps in the home itself, which its Finder hides too.
    expect(hiddenFolder("/Users/dev/Library", mac)).toBe(true);
    expect(hiddenFolder("/Users/dev/Library/", mac)).toBe(true);
    // A home is wherever the login puts it, and a lab account's is not /Users/<name>: the home decides, not the
    // path's shape, or every persona home on a Mac gets the junk drawer back.
    expect(hiddenFolder("/Users/Shared/lab/priya/Library", { home: "/Users/Shared/lab/priya", mac: true })).toBe(true);
    expect(hiddenFolder("/var/folders/t/session/Library", { home: "/var/folders/t/session", mac: true })).toBe(true);
    // A Library somebody made inside their own work is theirs, and so is one on a machine that is not a Mac.
    expect(hiddenFolder("/Users/dev/code/app/Library", mac)).toBe(false);
    expect(hiddenFolder("/root/Library", { home: "/root", mac: false })).toBe(false);
    expect(hiddenFolder("/Users/dev/Library", { home: "/Users/dev" })).toBe(false);
    expect(hiddenFolder("/Users/dev/Library")).toBe(false);
  });

  it("a machine says it is a Mac by the name its maker gives it, or by the kernel where it had nothing better", () => {
    expect(isMacMachine("macOS 15.5")).toBe(true);
    expect(isMacMachine("Darwin 25.4.0")).toBe(true);
    expect(isMacMachine("Ubuntu 24.04.1 LTS")).toBe(false);
    expect(isMacMachine("Debian GNU/Linux 12 (bookworm)")).toBe(false);
    // A machine that has answered nothing yet has said nothing to hide.
    expect(isMacMachine(undefined)).toBe(false);
    expect(isMacMachine("")).toBe(false);
  });
});

describe("the workspace a folder on this computer belongs to", () => {
  const here = project({ id: "pr_wsp", name: "wsp", path: "/Users/dev/wsp", source: folderSource("/Users/dev/wsp") });
  const nested = project({ id: "pr_host", name: "host", path: "/Users/dev/wsp/packages/host", source: folderSource("/Users/dev/wsp/packages/host") });
  const cloned = project({ id: "pr_front", name: "frontend", computer: "pl_box", path: "/root/frontend", source: gitSource("https://github.com/spoo-me/frontend") });
  const on = (p: ProjectView, id = `ws_${p.id}`) => ({ id, name: p.name, project: { id: p.id, name: p.name, path: p.path, computer: p.computer } });

  it("a folder under a project worked in place picks that project's workspace, the nearest when projects nest", () => {
    const wspWorkspace = on(here);
    const hostWorkspace = on(nested);
    expect(workspaceForFolder([wspWorkspace], [here], "/Users/dev/wsp")).toEqual({ workspace: wspWorkspace, project: here });
    expect(workspaceForFolder([wspWorkspace], [here], "/Users/dev/wsp/packages/host/src")).toEqual({ workspace: wspWorkspace, project: here });
    expect(workspaceForFolder([wspWorkspace, hostWorkspace], [here, nested], "/Users/dev/wsp/packages/host/src")).toEqual({ workspace: hostWorkspace, project: nested });
  });

  it("a folder no project holds, and a project no workspace stands on, name nothing", () => {
    expect(workspaceForFolder([on(here)], [here], "/Users/dev/elsewhere")).toBeNull();
    expect(workspaceForFolder([], [here], "/Users/dev/wsp")).toBeNull();
    expect(workspaceForFolder([on(here)], [], "/Users/dev/wsp")).toBeNull();
  });

  it("a project a computer cloned is on that computer, not here, so a folder of this name here is not it", () => {
    expect(workspaceForFolder([on(cloned)], [cloned], "/root/frontend")).toBeNull();
    expect(workspaceForFolder([on(cloned)], [cloned], "/Users/dev/frontend")).toBeNull();
  });

  it("the refusal names the folder and the road that records it", () => {
    expect(noWorkspaceForFolderLine("/Users/dev/my repo", "<workspace>")).toBe("no workspace holds a project for /Users/dev/my repo; name one with <workspace>, or wsp add '/Users/dev/my repo' records it as a project here");
    // The tool has no flag to pass, so its refusal names its own word.
    expect(noWorkspaceForFolderLine("/Users/dev/spoo", "workspace")).toContain("name one with workspace,");
  });

  it("the first line of a thread opened from inside a repo names the workspace and the folder", () => {
    expect(threadOpenedLine("1a2b3c4d", "b2", "~/spoo")).toBe("thread 1a2b3c4d on b2 in ~/spoo");
  });
});

describe("a project golden's manifest", () => {
  it("lists every project the snapshot carries, so a fork is told what it gets; a manifest with one project under the old field is not a golden", () => {
    const golden = { snapshotId: "snap_p", projects: [spoo, wsp], golden: "snap_g", version: 3, workspaceId: "ws_1", workspaceName: "b2", createdAt: "2026-09-06T09:00:00.000Z" };
    expect(ProjectGolden.parse(golden)).toEqual(golden);
    expect(ProjectGolden.safeParse({ ...golden, projects: undefined, project: spoo }).success).toBe(false);
    expect(projectsInPlace([spoo, wsp])).toBe(" with spoo, wsp in place");
    expect(projectsInPlace([])).toBe("");
    // A fork of the golden goes by the newest project it carries, the name new --from takes for it.
    expect(goldenForkName(golden)).toBe("wsp");
    expect(goldenForkName({ ...golden, projects: [] })).toBe("snap_p");
  });
});

describe("where a workspace of a project lands", () => {
  const here = { id: HERE_PLACE_ID, name: "zingzy-mbp" };
  const solari = { id: "solari", name: "Solari" };
  const box = { id: "p_2", name: "hetzner" };

  it("copies a folder on this computer for a project here, forks on the host's own provider for one there, and lands anywhere else on the place it names", () => {
    expect(workspaceLands(HERE_PLACE_ID, "solari")).toEqual({ at: "here" });
    expect(workspaceLands("solari", "solari")).toEqual({ at: "wired" });
    expect(workspaceLands("p_2", "solari")).toEqual({ at: "place", place: "p_2" });
    expect(workspaceLands("solari", undefined)).toEqual({ at: "place", place: "solari" });
  });

  it("puts a project here on this computer's row and never on the provider the host forks on", () => {
    expect(landsOn(HERE_PLACE_ID, here)).toBe(true);
    expect(landsOn(HERE_PLACE_ID, solari)).toBe(false);
    expect(landsOn("solari", solari)).toBe(true);
    expect(landsOn("Solari", solari)).toBe(true);
    expect(landsOn("hetzner", box)).toBe(true);
    expect(landsOn("p_2", solari)).toBe(false);
  });
});
