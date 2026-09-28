// SPDX-License-Identifier: AGPL-3.0-only
// The words the settings page and its palette row say, one place, keyed by the
// preference value where a value has words of its own.
import { fmtPx, offlineFor, placeUpdateLine, type PlaceDialRoad, type PlaceProvisionRow, type TerminalSizeSource, type ThemePreference } from "@wsp/protocol";

/** The muted mono a state word or a description of machine words wears, and the foreground mono a value a person
 * reads wears: an address, a size, a path, a time, a version. Two class strings the page, the sheet and the first
 * run all draw with, so one type ladder holds across them. */
export const FACT = "font-mono text-[11px] tabular-nums text-muted-foreground";
export const VALUE = "font-mono text-xs tabular-nums text-foreground";

/** A fact's slot where its words may take two lines: exactly two of the line's own line heights, held whether the
 * words take one line or two, and cut at the second with the whole on the element's hover text. The height is read
 * off the line itself (2lh) rather than written as a figure, so a slot and the text in it cannot disagree by the
 * half pixel that moved the first run's button between one line and two. */
export const TWO_LINE_SLOT = "min-h-[2lh] line-clamp-2";

export const SETTINGS_WORDS = {
  title: "Settings",
  search: "Search settings",
  searchPage: "Search",
  nothingMatches: "Nothing matches.",
  back: "Back",
  restore: "Restore defaults",
  appearance: "Appearance",
  theme: "Theme",
  /** The grid of one side's themes, named by the side's word. */
  themesOf: (side: string) => `${side} themes`,
} as const;

/** Each side as its segment names it. */
export const THEME_WORDS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/** The sentence under each settings page's name: what the page is for, before any row. */
export const GROUP_BLURBS = {
  general: "How wsp behaves on this Mac.",
  appearance: "How wsp looks, on every screen that opens it.",
  computers: "The computers your tasks run on. This Mac is the first one.",
  projects: "The repos wsp makes tasks from, each on one computer.",
  devices: "The phones and other computers paired with this wsp.",
  account: "Your sign-in, which lets your other devices find this wsp.",
  privacy: "What wsp asks of services outside your computers.",
  keybindings: "The keys wsp answers to.",
  about: "Which wsp this is.",
} as const;

/** What the Computers pages say beyond the words the wire already carries in PLACES_WORDS: the list row, a
 * computer's own page, its agents and the Remove dialog, which are this build's and are drawn nowhere else. No
 * word is in both. */
export const WHERE_WORDS = {
  icon: "Icon",
  iconDescription: "How this computer shows in the sidebar and here.",
  /** A place list the host refused, said where the list would stand. */
  notRead: (said: string) => `Computers not read: ${said}`,
  /** How a workspace's copy of a project is made on that computer, and the sentence for one that makes none. */
  copies: "Copies",
  copiesDescription: "How a task's copy of a project is made there.",
  copiesNothing: "copies nothing",
  /** What a copy there has for a network, in the protocol's own words off the flags the landing carries. */
  ports: "Ports",
  portsDescription: "What a task there has for a network.",
  workspaceThere: "A task there",
  connection: "Connection",
  workspaces: "Tasks",
  /** Puts this wsp's daemon on that computer and runs the recipe there again. One word in both states, held and
   * dimmed while it runs: a label that changed to Updating moved the button's own width. */
  update: "Update",
  updateTitle: (computer: string): string => `Update wsp on ${computer}`,
  updateDescription: "Puts this wsp's daemon there and runs the recipe again.",
  /** Why Update is held on a wsp whose client has no such request: said at the end of the row's description. */
  updateHeld: "Not on this wsp yet.",
  default: "default",
  remove: "Remove",
  removeTitle: (computer: string): string => `Remove ${computer}`,
  removeDescription: (computer: string): string => `wsp comes off ${computer} and its tasks' records leave this Mac. Your files there stay.`,
  removeCloudDescription: "Its key is forgotten on this Mac.",
  removing: "Removing…",
  cancel: "Cancel",
  /** Why a row's action is held: the op that carries it is not on the wire yet. */
  notYet: "not on this wsp yet",
  system: "System",
  systemHover: "What it reported last.",
  size: "Size",
  diskFree: "Disk free",
  spend: "Spend",
  joined: "Joined",
  answered: "Answered",
  answeredDescription: "When it last answered, and how long that frame took.",
  /** The row that says where the host expects that computer: the login it dials, or the address the computer
   * dialled in from, with the road it is. */
  address: "Address",
  addressDescription: "The ssh login it was installed over, or where it dialled in from.",
  /** The same row for a box that reaches this host only through a forward on its own loopback: the address it links
   * from is this computer's own, so the road back is said instead, in two lines at a phone's width. */
  addressBackDescription: (dialsBack: string): string => `It ${dialsBack}.`,
  cloud: "cloud",
  ago: (span: string): string => `${span} ago`,
  /** The button beside that reading, which asks the host to dial the computer once, worded by the road that dial
   * would take: a frame on the link the computer is holding, or the ssh login it was installed over. A computer
   * that joined by typing a code and is not answering has neither, and gets no button at all. */
  dial: { link: "Try now", ssh: "Try over ssh" } satisfies Record<PlaceDialRoad, string>,
  /** Its word while it is waiting on the answer: a pressed button keeps its variant and changes its word. */
  dialling: "Dialling…",
  /** What the app says when its own client carries no dial road, in place of a button that would ask nobody. A
   * whole sentence, because it stands after one in the pane's slot and a clause opening in lower case after a
   * full stop reads as a line that broke. */
  cannotDial: "This wsp cannot dial a computer from here.",
  cannotSaveKey: "This wsp cannot save a key from here.",
} as const;

/** What Add a computer says beyond PLACES_WORDS.sheet and the roads' own names. */
export const ADD_COMPUTER_WORDS = {
  title: "Add a computer",
  user: "User",
  host: "Host",
  hostPlaceholder: "box.example.com or an ssh alias",
  port: "Port",
  addComputer: "Add computer",
  whatHappens: "What happens",
  replace: "Replace",
  adding: "Adding",
  another: "Add another",
  signInsOn: (computer: string): string => `Sign-ins on ${computer}`,
  signInsWhy: (agents: readonly string[], computer: string): string =>
    `${new Intl.ListFormat("en", { type: "conjunction" }).format(agents)} ${agents.length === 1 ? "keeps" : "keep"} one login for every workspace on ${computer}, so sign in once here.`,
  suggested: "From your ssh config",
  copy: "Copy",
  copied: "Copied",
  notCopied: "not copied",
  replaceKey: "Paste a new key to replace it",
  /** Said only once the host lists that cloud as a computer: a key kept is not yet a place to fork on. */
  keySaved: "key saved",
  keyKept: "key kept; no computer yet",
  getKey: "Get a key",
  save: "Save",
  checking: "Checking",
  keyRefused: (provider: { name: string; keyConsole?: string }): { said: string; fix: string } => ({
    said: `${provider.name} refused that key.`,
    fix: provider.keyConsole === undefined ? "Check it and paste it again." : `Check it at ${provider.keyConsole} and paste it again.`,
  }),
  hostsNotRead: (said: string): string => `Hosts from your ssh config not read: ${said}`,
  installThere: "On that computer, install wsp",
  joinThere: "Then run",
  minting: "making a code",
  codeLeft: (ms: number): string => {
    const seconds = Math.ceil(ms / 1000);
    return `code works for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  },
  expired: "code expired",
  newCode: "New code",
  noMint: "this wsp cannot make a join line from the app yet",
  adds: "adds",
  /** Why Add is held on a wsp whose host cannot log in over ssh yet. */
  noRoad: "this wsp cannot log in over ssh yet",
  /** What to do about a login ssh would not take, short enough that what ssh said and this together stand on the
   * slot's two lines: a third line moves what is under them. There is no file picker on this road: the host reads
   * the ssh agent and config as they stand, so the key a box wants is named where every other ssh client reads it. */
  refusedFix: "Check the user and the address, or name a key in your ssh config.",
  running: "closing keeps it going",
  /** An add the host no longer lists while nothing here waits on it: the host restarted, or never got the ask. */
  hostLost: "The host lost track of this add, so how it ended is not known; add it again if the computer is not listed.",
} as const;

/** Each size source as its segment names it: whole at every width, since a cut segment is a defect. */
export const TERMINAL_SIZE_WORDS: Record<TerminalSizeSource, string> = {
  app: "App",
  file: "Ghostty file",
};

/** The size the picked source hands the pane, as the word beside the control: the app's own size, or the file's,
 * which is the app's again for a file that names none. */
export const TERMINAL_SIZE_FACT: Record<TerminalSizeSource, (appPx: number, filePx: number | undefined) => string> = {
  app: appPx => fmtPx(appPx),
  file: (appPx, filePx) => fmtPx(filePx ?? appPx),
};

/** Settings > Account: the one row that says who this wsp is signed in to and what a sign-in buys. The second
 * sentence is why the button is held: no op on the wire signs the app in yet. There is no word for being signed
 * in or not: the button standing there is that state. Nothing about the account is said anywhere else in the
 * window. */
export const ACCOUNT_WORDS = {
  title: "Account",
  github: "GitHub",
  signIn: "Sign in with GitHub",
  signOut: "Sign out",
  reach: "Sign in to use this wsp from outside your network. Not from the app yet.",
  reachable: "Reachable from another device outside your network. Not from the app yet.",
} as const;

/** Settings > Privacy: what this wsp asks of a service outside the person's computers. */
export const PRIVACY_WORDS = {
  title: "Privacy",
  serverIcons: "Server icons from Google",
  serverIconsDescription: "wsp asks Google for each public server's icon by host name; turning this off deletes the saved icons.",
  agentVersions: "Newest agent versions",
  agentVersionsDescription: "wsp asks npm, GitHub and each agent's maker for every agent's newest version, once a day.",
  agentVersionsHeld: "Off on the host: WSP_UPDATE_CHECK is 0.",
} as const;

/** Settings > Devices: every computer and browser paired with this wsp, and the one act on each. */
export const DEVICES_WORDS = {
  title: "Devices",
  thisBrowser: "this browser",
  paired: (when: string): string => `paired ${when}`,
  seen: (seen: string): string => `seen ${seen} ago`,
  /** A device this wsp heard from inside the minute: the span reads 0 min, which says nothing a person asked. */
  seenNow: "seen just now",
  revoke: "Revoke",
  revokeTitle: (name: string): string => `Revoke ${name}?`,
  revokeDescription: "It can no longer reach this wsp until it pairs again.",
  none: "Nothing is paired with this wsp yet.",
  /** A page served on a ticket socket is refused the list. */
  refused: "Who is paired is read on the computer running wsp.",
} as const;

/** Settings > Projects: the list, a project's own page and its one act. */
export const PROJECTS_WORDS = {
  look: "Look",
  about: "About",
  icon: "Icon",
  iconDescription: "Drawn beside the project in the sidebar and the switcher.",
  hue: "Colour",
  hueDescription: "The icon's colour, so the project reads at a glance.",
  title: "Projects",
  add: "Add a project",
  on: (computer: string): string => `on ${computer}`,
  none: "No projects yet.",
  noneDescription: "A project is a folder on one of your computers.",
  source: "Source",
  sourceHover: "The folder or repository this project is.",
  computer: "Computer",
  computerHover: "Where the project lives and where its tasks run.",
  remote: "Remote",
  remoteHover: "The repository it was cloned from.",
  added: "Added",
  addedHover: "When it was recorded.",
  seeded: "Seeded",
  seededHover: "What the seed carried from this Mac, once.",
  newWorkspaces: "New tasks",
  branch: "Branch",
  branchDescription: "Where a new task starts.",
  lastAgent: "Last agent",
  lastAgentDescription: "What a new thread on it defaults to.",
  remove: "Remove",
  removeTitle: (name: string): string => `Remove ${name}`,
  removeAsk: (name: string): string => `Remove ${name}?`,
  /** One line by the computer's kind, matching the runtime's three landings. */
  removeHere: "Its record leaves this wsp. Your folder stays as it is.",
  removeOnComputer: (computer: string): string => `Its record leaves this wsp, and wsp's own clone of it on ${computer} goes with it.`,
  removeAtCloud: (cloud: string): string => `Its record leaves this wsp, and its image at ${cloud} with it.`,
} as const;

/** Settings > Keybindings: the four cards' heads and the three keys that are not rules. */
export const KEYBINDINGS_WORDS = {
  title: "Keybindings",
  workspacesAndThreads: "Tasks and threads",
  terminal: "Terminal, while it has focus",
  fixed: "Fixed",
  sendMessage: "Send the message",
  submitComment: "Submit a diff comment",
  leaveSettings: "Leave Settings",
} as const;

/** Settings > About: the two halves of one release, and the road to the next. */
export const ABOUT_WORDS = {
  title: "About",
  app: "App",
  appHover: "The desktop shell holding this window.",
  host: "Host",
  hostHover: "The wsp that serves this page.",
  unknown: "unknown",
  releases: "Releases",
  latest: "Latest",
  readWhen: (ms: number): string => (ms < 60_000 ? "just now" : `${offlineFor(ms)} ago`),
  readHover: (when: string): string => `Read from the releases page ${when}.`,
  missedHover: (when: string, at: string): string => `Read ${when}; the releases page was not reached ${at}.`,
  unreachedHover: (at: string): string => `The releases page was not reached ${at}.`,
  offHover: "Update checks are off on the host: WSP_UPDATE_CHECK is 0.",
  computersBehind: "Computers behind",
  behindHover: (names: readonly string[]): string => `${names.join(", ")}: ${placeUpdateLine(names.length === 1 ? names[0]! : "<name>")}`,
  get: (version: string): string => `Get ${version}`,
  downloading: "Downloading",
  quitAndOpen: "Quit and open",
  restartHost: "Restart host",
  restartHover: "Drops open terminal panes, localhost forwards and any sign-in in progress; running turns continue.",
  restartRuns: "Restart host runs them.",
  restartThere: "A restart on the computer it runs on runs them.",
  hostUpdateHover: (line: string, version: string): string => `The wsp that serves this page. ${line} gets ${version}.`,
  hostInstalledHover: (installed: string, then: string): string => `The wsp that serves this page. Its files carry ${installed} now. ${then}`,
} as const;

/** What one row of the recipe on a computer came to, in the words the terminal's own lines say it in. The note a
 * row carries follows the word where it says why, which is a row that failed or was set aside. */
export const PROVISION_OUTCOME_WORDS: Record<PlaceProvisionRow["outcome"], string> = {
  installed: "installed",
  present: "already there",
  failed: "failed",
  skipped: "set aside",
};
