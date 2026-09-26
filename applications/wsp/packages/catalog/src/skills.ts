// SPDX-License-Identifier: AGPL-3.0-only
// Where each agent loads skills from. An agent entry names its own folders
// here; the reader lists every folder of every entry, so an agent the catalog
// gains needs nothing in the reader.
import { SKILL_NAME } from "./context.js";

/** One folder an agent loads skills from, one folder per skill with a SKILL.md inside: `~/`-relative for the
 * person's own, project-relative for a project's. `lands` is how an install puts a skill there: its files, or a
 * link to the one copy in the shared folder. */
export interface SkillRoot {
  dir: string;
  lands: "copy" | "link";
}

/** The folder several agents read as their own and the skills CLI keeps the one copy of a skill in. */
export const SHARED_SKILLS = "~/.agents/skills";

/** The same folder inside a project. */
export const PROJECT_SHARED_SKILLS = ".agents/skills";

/** The XDG agents folder, which several agents read beside the shared one and none of them owns. */
export const XDG_SHARED_SKILLS = "~/.config/agents/skills";

/** An agent's skill folders: its own first, which is where the wsp skill goes with the MCP server, then the ones it
 * also reads; and the folders it reads inside a project. */
export interface SkillRoots {
  user: readonly [SkillRoot, ...SkillRoot[]];
  project: readonly SkillRoot[];
}

/** Skills a plugin brings: the index file that names each installed plugin's folder, and the skill folders that
 * index names. Read, never written: a plugin's skills come and go with the plugin. */
export interface PluginSkills {
  index: string;
  roots(text: string): string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Claude Code's installed_plugins.json, version 2 (read 2026-09-24 on 2.1.281): `plugins.<name@marketplace>` is a
 * list of installs, each with its scope and installPath; a user-scoped install's skills are under
 * `<installPath>/skills`. A project-scoped one belongs to that project and is left out. */
export const CLAUDE_PLUGIN_SKILLS: PluginSkills = {
  index: "~/.claude/plugins/installed_plugins.json",
  roots: text => {
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      return [];
    }
    const plugins = isObject(root) && isObject(root.plugins) ? root.plugins : {};
    const out = new Set<string>();
    for (const installs of Object.values(plugins)) {
      if (!Array.isArray(installs)) continue;
      for (const i of installs) if (isObject(i) && i.scope === "user" && typeof i.installPath === "string" && i.installPath.startsWith("/")) out.add(`${i.installPath.replace(/\/+$/, "")}/skills`);
    }
    return [...out];
  },
};

/** Where an install puts a skill for one agent, a project's with `project`: nothing where the agent reads the shared
 * folder already, else its own folder with how that folder takes a skill. */
export function ownSkillFolder(a: { skillRoots: SkillRoots }, project: boolean): SkillRoot | undefined {
  const roots = project ? a.skillRoots.project : a.skillRoots.user;
  if (roots.some(r => r.dir === (project ? PROJECT_SHARED_SKILLS : SHARED_SKILLS))) return undefined;
  return roots[0];
}

/** The folder the agent's own skills go in, where the wsp skill is written. */
export const skillsDirOf = (a: { skillRoots: SkillRoots }): string => a.skillRoots.user[0].dir;

/** The skill's folder name under every agent's skills directory on the person's own computer, and its frontmatter name. */
export const WSP_SKILL_NAME = "wsp";

/** A skill wsp writes and rewrites itself, on the person's computer or on a machine it made: never the person's to
 * turn off or remove, since the next start puts it back. */
export const isSystemSkill = (name: string): boolean => name === WSP_SKILL_NAME || name === SKILL_NAME;
