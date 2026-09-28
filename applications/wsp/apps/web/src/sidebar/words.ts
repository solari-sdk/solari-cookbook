// SPDX-License-Identifier: AGPL-3.0-only
// The words the sidebar's own screens say: the act that makes a workspace,
// wherever it is offered; the first run, which is the whole window while this
// wsp holds no project; the project rows and the switcher over them; and the
// sheet that records one.
// Nothing here says what a workspace is made of: that pair of words is the
// protocol's table (madeOfWord, portsWord), so a row in the app and a cell in
// the command line's table cannot say two things about one workspace.
import { THIS_COMPUTER_WORD } from "../settings/places.js";

/** The one word for the act, read by the plus on a project, the palette row and the dialog's own title: three
 * surfaces offering one act, so none of them can name it differently. */
export const NEW_WORKSPACE = "New task";

/** The one question a workspace is made by, asked on the first run and in the dialog: one question, one wording,
 * and its ghost is a piece of work rather than a name shaped like a machine's. */
export const WORK_QUESTION = "What are you working on";
export const WORK_GHOST = "pricing page";

/** The screen a person meets on a wsp that holds no project: one folder, one question, one key. Its button says
 * Start, since the screen has one act and its title says what that act starts. */
export const FIRST_RUN_WORDS = {
  title: "Add a project to get started",
  sentence: `A project is a git repo on ${THIS_COMPUTER_WORD}. Every piece of work on it gets its own copy.`,
  add: "Add a project",
} as const;

/** The project's own rows in the sidebar: its menu, the leaf under a project nobody has started work on, the
 * switcher menu's foot that records another one, and the one row the sidebar holds while this wsp has no project,
 * which sends a person to the first run in the centre. */
export const PROJECT_WORDS = {
  add: "Add a project",
  new: "New project",
  settings: "Project settings",
  remove: "Remove project",
  noWorkspaces: "No tasks yet.",
  notRead: (said: string) => `Projects not read: ${said}`,
} as const;

/** The project switcher at the head of the sidebar: the pick that shows every project, and its menu's search. */
export const SWITCHER_WORDS = {
  all: "All projects",
  search: "Search projects",
  settingsOf: (name: string) => `${name} settings`,
} as const;

/** Why Create waits on the one question the dialog asks. */
export const SAY_THE_WORK = "say what you are working on";

/** The sheet that records a project: one source on one computer, and nothing else. The computer pick appears only
 * where there is a computer beyond this one and the source is a repository address, which is what says which road
 * the source takes; there is no sentence under the field saying it. */
export const ADD_PROJECT_WORDS = {
  title: PROJECT_WORDS.add,
  search: "Search your repos, or type a path",
  addressOnly: "Paste a repository address",
  choose: "Choose",
  add: "Add",
  computers: "Computers",
  addComputer: "Add a computer",
  look: "Look",
  navigate: "Navigate",
  open: "Open",
  complete: "Complete",
  byPath: "Type a path",
  reposOn: (name: string) => `Repos on ${name}`,
  noRepos: "No git repos found under your home folder. Type a path to one.",
  noFolders: "No folders here.",
  noMatch: "No repo matches.",
  added: "added",
  noCloneHere: `A repository address is cloned on a box, Solari or ASCII. ${THIS_COMPUTER_WORD}'s projects are folders you already have.`,
  cloneLine: (url: string, on: string) => `Clone ${url} on ${on}`,
  boxSays: (name: string) => `Repos on ${name} show here soon. Paste a repository address above to clone it there.`,
  providerSays: (name: string) => `${name} clones a project from its repository address. Paste one above.`,
} as const;
