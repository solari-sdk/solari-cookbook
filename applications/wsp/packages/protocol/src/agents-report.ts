// SPDX-License-Identifier: AGPL-3.0-only
// What stands on one computer or workspace for the agents: each agent with its
// version and sign-in word, every skill with every folder it lives in, every
// MCP server with how it is reached. One report serves the app, the command
// line and the MCP tools. Names and states only: no value of a key, a token,
// a header or an env variable is ever in it.
import { z } from "zod";

/** Whether an agent on a computer can run a turn there without anybody signing anything in: its own login stands on
 * that computer, the vault this host holds has the variable that agent reads, or neither. One word per agent, worked
 * out by the host from the computer's report and the vault, since the computer knows no catalog. */
export const AgentSignInState = z.enum(["signed-in", "vault-key", "none"]);
export type AgentSignInState = z.infer<typeof AgentSignInState>;

/** What a report is read off: a computer by the id places.list gives it (this one's included), with `project` one of
 * the projects on it by its id or its name, which is what an act on that project's skills and servers names; or one
 * workspace. */
export const AgentsTarget = z.union([z.object({ placeId: z.string(), project: z.string().optional() }).strict(), z.object({ workspaceId: z.string() }).strict()]);
export type AgentsTarget = z.infer<typeof AgentsTarget>;

/** A project a report read the folders of, by the id and name projects.list gives it and its folder on that
 * computer, `~`-relative under the home: every project on a computer, or a workspace's own. */
export const AgentsProject = z.object({ id: z.string(), name: z.string(), path: z.string() });
export type AgentsProject = z.infer<typeof AgentsProject>;

/** Why a target named a project the computer does not hold. */
export const noSuchAgentsProjectRefusal = (id: string, computer: string): string => `There is no project ${id} on ${computer}.`;

/** Why a target named a project by a name two projects on that computer share. */
export const sharedAgentsProjectRefusal = (name: string, computer: string): string => `Two projects on ${computer} are named ${name}; name one by the id wsp projects shows.`;

/** How the agent's binary got onto that computer: by wsp's own install under its tools folder, by the person or
 * another installer (`own`), as a wrapper another program puts in front of it (`shim`), or it is not there. */
export const AgentRoad = z.enum(["wsp", "own", "shim", "none"]);
export type AgentRoad = z.infer<typeof AgentRoad>;

/** How a person signs the agent in where it stands: a device page, a code pasted back, a key, a token minted here,
 * the agent's own terminal because it asks the person to pick, or no sign-in at all. Off the catalog's sign-in row. */
export const SignInRoad = z.enum(["device", "code", "key", "token", "terminal", "none"]);
export type SignInRoad = z.infer<typeof SignInRoad>;

export const AgentRow = z.object({
  id: z.string(),
  name: z.string(),
  /** The agent's command answers on that computer's login PATH. */
  installed: z.boolean(),
  version: z.string().optional(),
  /** The newest version its vendor publishes, read by this host. */
  latest: z.string().optional(),
  /** The version the catalog installs. */
  pinned: z.string().optional(),
  road: AgentRoad,
  /** Where the command answers from, `~`-relative under the home: past any wrapper another app put first on PATH. */
  path: z.string().optional(),
  /** The app whose wrapper answers first on the login PATH, in front of the binary at path. */
  via: z.string().optional(),
  signIn: z.union([AgentSignInState, z.literal("unknown")]),
  signInRoad: SignInRoad,
  /** One of its MCP config files names the wsp server. */
  wspTools: z.boolean(),
});
export type AgentRow = z.infer<typeof AgentRow>;

/** One folder a skill lives in: `~`-relative, the agent whose own folder it is (none for a folder several agents
 * read), where a link points when the folder is one, and whether it is turned off: its SKILL.md renamed
 * SKILL.md.off, which no agent loads. */
export const SkillPath = z.object({ path: z.string(), agent: z.string().optional(), linkTo: z.string().optional(), off: z.literal(true).optional() });
export type SkillPath = z.infer<typeof SkillPath>;

export const SkillScope = z.enum(["user", "project", "plugin"]);
export type SkillScope = z.infer<typeof SkillScope>;

/** One skill by its name, with every folder it lives in. `description` is off its SKILL.md's frontmatter; `project`
 * is the project a project skill lives in. */
export const SkillRow = z.object({ name: z.string(), description: z.string().optional(), paths: z.array(SkillPath).min(1), scope: SkillScope, project: AgentsProject.optional() });
export type SkillRow = z.infer<typeof SkillRow>;

/** One skill skills.sh lists for a search: `id` is `<owner>/<repo>/<skill>`, what an install names. */
export const SkillHit = z.object({ id: z.string(), source: z.string(), skillId: z.string(), name: z.string(), installs: z.number().int().nonnegative() });
export type SkillHit = z.infer<typeof SkillHit>;

/** How much of a SKILL.md a preview carries. */
export const SKILL_PREVIEW_BYTES = 64 * 1024;

/** A skill's SKILL.md as a preview draws it: its first part, up to SKILL_PREVIEW_BYTES, and the whole file's size. */
export const SkillPreview = z.object({ text: z.string(), size: z.number().int().nonnegative() });
export type SkillPreview = z.infer<typeof SkillPreview>;

/** Where an install put a skill: its one folder, and each agent's folder that got a link to it or a copy of it. */
export const SkillAdded = z.object({ path: z.string(), agents: z.array(z.object({ agent: z.string(), path: z.string() })) });
export type SkillAdded = z.infer<typeof SkillAdded>;

/** Why a search was not sent: skills.sh refuses an empty one. */
export const skillsSearchEmptyRefusal = "Type something to search skills.sh for.";

/** Why the skill wsp writes is never turned off or removed: the next start writes it again. */
export const systemSkillRefusal = (name: string): string => `${name} is written by wsp and kept current on every start, so it is always on.`;

/** Why a plugin's skill is not turned off or removed on its own. */
export const pluginSkillRefusal = (name: string): string => `${name} comes with a plugin; turn the plugin off instead.`;

/** Why a project's skill is not turned off: it lives in the repo, and the rename would be a change to it. */
export const projectSkillOffRefusal = (name: string, path: string): string => `${name} lives in the repo at ${path}, so it is not turned off here.`;

/** Why an act named a skill the computer does not have. */
export const noSuchSkillRefusal = (name: string): string => `There is no skill named ${name} there.`;

/** Why a napping workspace's skills were not read or changed: nothing here wakes a machine. */
export const nappingSkillsRefusal = (name: string): string => `${name} is napping, and its skills are read and changed only while it runs; wake it first`;

/** A command line as a person types it, in words: split at spaces, a word in single quotes as written, one in double
 * quotes with its backslash escapes, and a backslash outside quotes taking the next character as it is. Nothing is
 * expanded; a line with a quote it never closes has no words, as a shell refuses it. */
export function commandWords(line: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      word ??= "";
      for (i++; i < line.length && line[i] !== '"'; i++) word += line[i] === "\\" && i + 1 < line.length ? line[++i]! : line[i]!;
      if (i >= line.length) return undefined;
    } else if (c === "\\" && i + 1 < line.length) word = (word ?? "") + line[++i]!;
    else if (/\s/.test(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + c;
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** Why a command line was refused before anything was sent. */
export const unclosedQuoteRefusal = "The command has a quote it never closes, so nothing was written.";

/** Why a server's name was refused: the agent's own format would not read it back as that name. */
export const serverNameFormatRefusal = (agent: string): string => `${agent} cannot keep a server under that name, so nothing was written.`;

/** Why a server's name was refused before anything was written: empty, or holding a control character. */
export const serverNameRefusal = "A server's name needs at least one character and no control character, so nothing was written.";

/** Why an act named a server the agent's file does not define in that scope. */
export const noSuchServerRefusal = (name: string, file: string): string => `There is no server named ${name} in ${file}.`;

/** Why an add did not write over a server of the same name. */
export const serverThereRefusal = (name: string, file: string): string => `${name} is already in ${file}, so nothing was written; remove it first or pick another name.`;

/** Why a config that is a link out of the home, or out of the project for a project's file, was not written. */
export const configLinkRefusal = (file: string, to: string): string => `${file} is a link to ${to}, outside the folder it belongs to, so wsp does not write through it.`;

/** Why a config was not written: a second hard link to it would keep the old text after a write by rename; and how
 * to find that link and let the write through. */
export const configHardLinkRefusal = (file: string): string =>
  `${file} has another hard link, which a write by rename would split from it, so nothing was written. See the link count with ls -li ${file} and find the other name with find / -xdev -samefile ${file}, since a hard link stays on its own volume; remove that name or give ${file} a copy of its own, then run the command again.`;

/** Why a write stopped: the agent or the person wrote the file between wsp's read and its write. */
export const configChangedRefusal = (file: string): string => `${file} changed while wsp was writing it, so nothing was written; try again.`;

/** Why a server was not turned off or on: its agent keeps no switch per server that wsp turns. */
export const noServerSwitchRefusal = (agent: string): string => `${agent} keeps no switch per server that wsp turns, so nothing was changed.`;

/** Why an agent's servers were not changed: it keeps none in a file wsp writes. */
export const noServersConfigRefusal = (agent: string): string => `${agent} keeps no MCP servers in a file wsp writes.`;

/** Why a napping workspace's servers were not changed: nothing here wakes a machine. */
export const nappingServersRefusal = (name: string): string => `${name} is napping, and its servers are changed only while it runs; wake it first`;

/** One property of a tool's input, off its input schema: its name, the type its schema gives it where it gives one,
 * and whether a call has to carry it. */
export const McpToolParam = z.object({ name: z.string(), type: z.string().optional(), required: z.boolean(), description: z.string().optional() });
export type McpToolParam = z.infer<typeof McpToolParam>;

/** One tool a server lists, as its tools/list answers it. */
export const McpTool = z.object({ name: z.string(), description: z.string().optional(), params: z.array(McpToolParam).optional() });
export type McpTool = z.infer<typeof McpTool>;

/** How a server is reached, shown and never run: the command with every value of the person's hidden, or the host
 * of its url. */
export const McpRowTransport = z.discriminatedUnion("kind", [z.object({ kind: z.literal("stdio"), line: z.string() }), z.object({ kind: z.literal("http"), host: z.string() })]);
export type McpRowTransport = z.infer<typeof McpRowTransport>;

/** A server's state: nothing to sign in as its config says, unchecked (`open`); a token its config takes from the
 * environment (`env-key`); its address answered with no sign-in asked (`connected`); a sign-in its harness holds
 * (`signed-in`); one it needs; one that failed; or no way to tell without connecting (`unknown`). */
export const McpAuth = z.enum(["open", "env-key", "connected", "signed-in", "needs-sign-in", "failed", "unknown"]);
export type McpAuth = z.infer<typeof McpAuth>;

/** `home`: Claude Code's servers kept for the home folder itself; `project`: a workspace's project files. */
/** Where a page that returns to localhost reaches the harness: `here`, the computer the browser is on; `relay`, a
 * computer whose callback port this host forwards from here; `none`, a computer it does not. */
export const PageReach = z.enum(["here", "relay", "none"]);
export type PageReach = z.infer<typeof PageReach>;

export const McpScope = z.enum(["user", "home", "project"]);
export type McpScope = z.infer<typeof McpScope>;

/** One MCP server of one agent's config on a target, in the scope the report read it from; the person's own when
 * unsaid. */
export const ServerAsk = z.object({ agent: z.string(), name: z.string(), scope: McpScope.optional() });
export type ServerAsk = z.infer<typeof ServerAsk>;

/** One MCP server to write into an agent's config on a target, the project's with `project`: a command with its
 * arguments and variables, or an address with its headers, as the person typed them. `env` and `headers` carry the
 * values, which go into that file and nowhere else. */
export const ServerAdd = z.object({
  agent: z.string(),
  name: z.string(),
  project: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
});
export type ServerAdd = z.infer<typeof ServerAdd>;

export const McpRow = z.object({
  agent: z.string(),
  name: z.string(),
  scope: McpScope,
  /** The config file it is defined in, `~`-relative under the home. */
  file: z.string(),
  transport: McpRowTransport,
  /** The variables its definition sets or reads, names only. */
  envNames: z.array(z.string()),
  auth: McpAuth,
  enabled: z.boolean(),
  /** On a computer you own: whether wsp's recipe job put it there. Absent where no recipe job keeps a record. */
  inRecipe: z.boolean().optional(),
  tools: z.array(McpTool).optional(),
  /** The project a project server is set up in. */
  project: AgentsProject.optional(),
});
export type McpRow = z.infer<typeof McpRow>;

/** What one server said when it was started once, or asked once over its address, on the person's click: its sign-in
 * as that connect found it, and its tools. `holder` is the agent whose harness holds the server's sign-in, which
 * this host never reads, so no list comes back for it; `refused` is why nothing came back. */
export const ServerToolsAnswer = z.object({
  auth: McpAuth,
  tools: z.array(McpTool).optional(),
  holder: z.string().optional(),
  refused: z.string().optional(),
  readAt: z.string(),
});
export type ServerToolsAnswer = z.infer<typeof ServerToolsAnswer>;

/** Why a server started for its tools gave none: it had not answered when its time was up, and was stopped. */
export const serverToolsLateRefusal = (ms: number): string => `Did not answer in ${Math.round(ms / 1000)} s.`;

export const AgentsReport = z.object({
  target: AgentsTarget,
  home: z.string(),
  /** The login every read ran as: the owner of the home. */
  user: z.string(),
  readAt: z.string(),
  /** The workspace is napping and this is the last report read while it ran; nothing was asked of it. */
  stale: z.literal("napping").optional(),
  agents: z.array(AgentRow),
  skills: z.array(SkillRow),
  servers: z.array(McpRow),
  /** One line per reader that could not answer, naming it. */
  refused: z.array(z.string()),
  /** Every project whose folders the read covered, rows or none: each one a computer holds, or a workspace's own. */
  projects: z.array(AgentsProject).optional(),
  /** Where a sign-in page that returns to localhost reaches the harness there; absent reaches nowhere. */
  reach: PageReach.optional(),
});
export type AgentsReport = z.infer<typeof AgentsReport>;

/** Why a cloud account's row has no report: nothing stands there between forks. */
export const providerAgentsRefusal = (name: string): string =>
  `${name} keeps no computer to read, since every workspace there is forked fresh from the image; name a workspace there, or edit the image`;

/** Why a napping workspace read nothing: a read never wakes a machine, and none was read while it ran. */
export const nappingAgentsRefusal = (name: string): string => `${name} is napping and was not read while it ran; wake it to read what stands there`;

/** Why a napping workspace's server was not started: nothing here wakes a machine. */
export const nappingToolsRefusal = (name: string): string => `${name} is napping, and a server is started there only while it runs; wake it to list the tools`;

/** Why a computer that runs every line as root refused to read: the lines would run as root in somebody's home. */
export const noRunuserRefusal = (user: string): string => `this computer runs wsp as root and has no runuser to run as ${user}, the owner of the home, so nothing was read`;

/** Why a computer that runs every line as root refused to read: the home it names is not there, so there is no
 * owner to hand the lines to and running them as root is not an answer. */
export const noHomeRefusal = (home: string): string => `this computer runs wsp as root and its home ${home} is not there, so nothing was read`;

/** Where one sign-in started from the app stands, pushed to the socket that started it and no other: `running` until
 * the tool prints a page, `waiting` once it has, with that page, the code the tool printed beside it where it prints
 * one, and `paste` where what the page hands back is typed into the tool; then `signed-in`, or `failed` with the
 * tool's own last words. */
export const AgentsSignInEvent = z.object({
  type: z.literal("agents.signIn"),
  signInId: z.string(),
  state: z.enum(["running", "waiting", "signed-in", "failed"]),
  url: z.string().optional(),
  code: z.string().optional(),
  paste: z.boolean().optional(),
  said: z.string().optional(),
});
export type AgentsSignInEvent = z.infer<typeof AgentsSignInEvent>;

/** Something written changed what a report there reads: a sign-in, a key in the vault, the wsp tools in a config.
 * No target: every report, which is what a key in this host's vault changes. */
export const AgentsChangedEvent = z.object({ type: z.literal("agents.changed"), target: AgentsTarget.optional() });
export type AgentsChangedEvent = z.infer<typeof AgentsChangedEvent>;

/** One sign-in as a line on the computer it runs on, for the person's own terminal: what runs first (the store's
 * folder, where the login lives outside the home), the command, the environment it runs with, and the tool's own
 * status line afterwards. Paths and commands only, never a value. */
export const SignInLine = z.object({ command: z.string(), env: z.record(z.string()).optional(), prepare: z.string().optional(), status: z.string().optional() });
export type SignInLine = z.infer<typeof SignInLine>;

/** A paste the agent's token check refused. */
export const notTokenRefusal = (agent: string): string => `That is not a ${agent} token.`;

/** Why an agent has no key for this host to keep. */
export const noVaultKeyRefusal = (agent: string): string => `${agent} takes no token or key this host keeps.`;

/** Why an agent's sign-in is not run for the app: it asks the person to pick, so it runs in their terminal. */
export const signInTerminalRefusal = (agent: string, line: string): string => `${agent} asks you to pick while it signs in, so it runs in your terminal: ${line}`;

/** Why an agent has no sign-in to run: it signs in with a token or key this host keeps, or not at all. */
export const signInVaultRefusal = (agent: string): string => `${agent} has no sign-in to run on a computer; it reads a token or key this host keeps.`;

/** Why a server's sign-in is not run for the app, with the line the person runs instead. */
export const serverSignInCopyRefusal = (agent: string, line: string, why: "inside" | "callback"): string =>
  why === "inside" ? `${agent} signs a server in inside its own session: ${line}` : `${agent} finishes a server's sign-in on a page at localhost, which reaches only the computer your browser is on; run ${line} in a terminal there.`;

/** Why the wsp tools go only into an agent's config on this computer: a thread elsewhere is handed them on every turn. */
export const addToolsHereRefusal = "The wsp tools go into an agent's config on this computer; a thread on any other computer is handed them with every turn.";

/** A C0 control character or DEL: what an interactive terminal acts on rather than shows, so a name holding one is
 * never a name wsp runs anything by. */
export const hasControlChar = (s: string): boolean => /[\x00-\x1f\x7f-\x9f]/.test(s);

/** The text with every control character taken out, for a name that reaches a log line. */
export const withoutControlChars = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

/** Why a server a config names was left out of the report. */
export const controlNameRefusal = (file: string): string => `${file} names a server with a control character in its name, which was left out.`;

/** Why a sign-in naming a server or an agent with a control character in it was not run. */
export const controlSignInRefusal = "That name holds a control character, so no sign-in runs for it.";

/** The sign-in a code was sent to is not running. */
export const noSignInRefusal = "That sign-in is not running any more.";

/** Why a napping workspace ran no sign-in: nothing here wakes a machine. */
export const nappingSignInRefusal = (name: string): string => `${name} is napping, and a sign-in runs there only while it runs; wake it to sign in`;

/** Why agents.signInLine was refused: the line is for the host's own command line, which runs it in the person's
 * terminal. */
export const SIGN_IN_LINE_REFUSAL = "only the host's own command line asks for a sign-in's line; run wsp agents signin on the computer the host runs on";

/** Why agents.key was refused: a token goes into the vault only from a socket holding this host's own token. */
export const AGENTS_KEY_REFUSAL = "only a socket holding this host's own token may put a key in its vault; use the app on the computer the host runs on, or wsp agents key there";
