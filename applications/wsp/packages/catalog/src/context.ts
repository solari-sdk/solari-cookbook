// SPDX-License-Identifier: AGPL-3.0-only
// How each agent loads the machine context on the guest: the always-loaded
// hook that carries the short text, the global skills directory that takes
// the full document, the probe condition that says when the person's own
// file already claims that hook, and what is true of a cd in its tool shell.
// One module per agent, registered on its catalog entry; the engine renders
// the texts, runs the probe and lands the files.
import { shellQuote } from "@wsp/protocol";

/** The first line of the source file and of every copy, so a person who finds one knows where it comes from. */
export const CONTEXT_MARKER = "wsp writes this file when a workspace is forked; edits are overwritten.";

export const SKILL_NAME = "wsp-machine";

/** Where the guest keeps system files and the home; tests point both at a temp dir. */
export interface GuestRoots {
  etc: string;
  home: string;
}

export interface GuestFile {
  path: string;
  mode: number;
  content: string;
}

export type ContextOutcomeKind = "written" | "fallback" | "not-loaded";

export interface ContextHookInput {
  /** The short text and the skill document, rendered for this agent. */
  short: string;
  skill: string;
  /** The shared short text's path on the guest, for a hook that reads it from there. */
  source: string;
  roots: GuestRoots;
  /** The person's own file already claims the always-loaded hook. */
  conflict: boolean;
  fish: boolean;
}

/** What one agent gets: the files to land, how its always-loaded text arrives, and where its skill sits. */
export interface ContextHooks {
  outcome: ContextOutcomeKind;
  files: GuestFile[];
  /** The always-loaded hook, or the fallback that stands in for it. */
  path?: string;
  /** Why the always-loaded hook was not written. */
  note?: string;
  skill: string;
}

export interface AgentContext {
  /** What a cd does in this agent's tool shell and how to work in a folder; absent, the facts verified for every agent. */
  cd?: { fact: string; howto: string };
  /** A shell condition, true when the person's own file sets the key the hook would; absent, no file of theirs can. */
  conflict?: (roots: GuestRoots) => string;
  hooks(input: ContextHookInput): ContextHooks;
}

/** The mode of every file the context puts on the guest. */
export const MODE = 0o644;
const file = (path: string, content: string): GuestFile => ({ path, mode: MODE, content });
const skillAt = (dir: string, skill: string): GuestFile => file(`${dir}/${SKILL_NAME}/SKILL.md`, skill);

/** The text as a TOML string: a literal multi-line string, which needs no escaping, unless the text holds the
 * one sequence that would end it. */
function tomlString(doc: string): string {
  if (!doc.includes("'''")) return `'''\n${doc}'''`;
  return JSON.stringify(doc);
}

/** True when settings.json has a context.fileName of its own, comments and trailing commas allowed. */
const GEMINI_FILENAME_CHECK = [
  'const t=require("fs").readFileSync(process.argv[1],"utf8");',
  'let o="",i=0,s=false;',
  "while(i<t.length){const c=t[i];",
  'if(s){o+=c;if(c==="\\\\"&&i+1<t.length)o+=t[++i];else if(c===\'"\')s=false;i++}',
  'else if(c===\'"\'){s=true;o+=c;i++}',
  'else if(c==="/"&&t[i+1]==="/"){while(i<t.length&&t[i]!=="\\n")i++}',
  'else if(c==="/"&&t[i+1]==="*"){const e=t.indexOf("*/",i+2);i=e<0?t.length:e+2}',
  "else{o+=c;i++}}",
  "let hit;try{const j=JSON.parse(o);hit=!!(j&&j.context&&j.context.fileName!==undefined)}catch{hit=/\"fileName\"\\s*:/.test(o)}",
  "process.exit(hit?0:1)",
].join("");

/** True when agent.environment_hint is set to something other than an empty string. */
const HERMES_HINT_CHECK = [
  "/^[^[:space:]#]/{blk=$1}",
  'blk=="agent:" && /^[[:space:]]+environment_hint[[:space:]]*:/{v=$0; sub(/^[^:]*:[[:space:]]*/,"",v); sub(/[[:space:]]+#.*$/,"",v); if (v!="" && v!="\\"\\"" && v!="\'\'") f=1}',
  "END{exit !f}",
].join(" ");

/** Only Claude Code's tool shell is known to persist across tool calls, with the files pane following it. */
export const CLAUDE_CONTEXT: AgentContext = {
  cd: {
    fact: "- Every agent session starts in the thread's folder; terminal panes open in the home folder. A cd moves your own shell, which persists across your tool calls, not the thread's folder, and the files pane follows that shell's folder unless you pinned the panes.",
    howto: "- Work in a folder: cd <dir> in your shell and it stays there across your tool calls; the thread's folder does not move. Absolute paths work from anywhere.",
  },
  hooks: ({ short, skill, roots: { etc } }) => {
    const s = skillAt(`${etc}/claude-code/.claude/skills`, skill);
    return { outcome: "written", path: `${etc}/claude-code/CLAUDE.md`, files: [file(`${etc}/claude-code/CLAUDE.md`, short), s], skill: s.path };
  },
};

/** Additive: the requirements layer's developer message lands beside the person's developer_instructions, never under them. */
export const CODEX_CONTEXT: AgentContext = {
  hooks: ({ short, skill, roots: { etc } }) => {
    const s = skillAt(`${etc}/codex/skills`, skill);
    return { outcome: "written", path: `${etc}/codex/requirements.toml`, files: [file(`${etc}/codex/requirements.toml`, `# ${CONTEXT_MARKER}\nadditional_developer_instructions = ${tomlString(short)}\n`), s], skill: s.path };
  },
};

export const GEMINI_CONTEXT: AgentContext = {
  conflict: ({ home }) => `[ -f ${home}/.gemini/settings.json ] && node -e ${shellQuote(GEMINI_FILENAME_CHECK)} ${home}/.gemini/settings.json 2>/dev/null`,
  hooks: ({ short, skill, roots: { etc, home }, conflict }) => {
    const s = skillAt(`${home}/.gemini/skills`, skill);
    if (conflict) {
      const dir = `${home}/.gemini/extensions/${SKILL_NAME}`;
      const manifest = `${JSON.stringify({ name: SKILL_NAME, version: "1.0.0", contextFileName: "WSP-MACHINE.md" }, null, 2)}\n`;
      return { outcome: "fallback", path: dir, note: "~/.gemini/settings.json sets context.fileName", files: [file(`${dir}/gemini-extension.json`, manifest), file(`${dir}/WSP-MACHINE.md`, short), s], skill: s.path };
    }
    return {
      outcome: "written",
      path: `${home}/.gemini/WSP-MACHINE.md`,
      files: [file(`${etc}/gemini-cli/system-defaults.json`, `${JSON.stringify({ context: { fileName: ["GEMINI.md", "WSP-MACHINE.md"] } }, null, 2)}\n`), file(`${home}/.gemini/WSP-MACHINE.md`, short), s],
      skill: s.path,
    };
  },
};

export const OPENCODE_CONTEXT: AgentContext = {
  hooks: ({ skill, source, roots: { etc, home } }) => {
    const s = skillAt(`${home}/.config/opencode/skills`, skill);
    return { outcome: "written", path: `${etc}/opencode/opencode.json`, files: [file(`${etc}/opencode/opencode.json`, `${JSON.stringify({ instructions: [source] }, null, 2)}\n`), s], skill: s.path };
  },
};

export const PI_CONTEXT: AgentContext = {
  conflict: ({ home }) => `[ -f ${home}/.pi/agent/APPEND_SYSTEM.md ] && ! head -n 1 ${home}/.pi/agent/APPEND_SYSTEM.md | grep -qF ${shellQuote(CONTEXT_MARKER)}`,
  hooks: ({ short, skill, source, roots: { home }, conflict }) => {
    const s = skillAt(`${home}/.pi/agent/skills`, skill);
    if (conflict) {
      const ext = `${home}/.pi/agent/extensions/${SKILL_NAME}.ts`;
      const code = [
        `// ${CONTEXT_MARKER}`,
        'import { readFileSync } from "node:fs";',
        "export default function (pi) {",
        `  pi.on("before_agent_start", async event => ({ systemPrompt: \`\${event.systemPrompt}\\n\\n\${readFileSync(${JSON.stringify(source)}, "utf8")}\` }));`,
        "}",
        "",
      ].join("\n");
      return { outcome: "fallback", path: ext, note: "~/.pi/agent/APPEND_SYSTEM.md already exists", files: [file(ext, code), s], skill: s.path };
    }
    return { outcome: "written", path: `${home}/.pi/agent/APPEND_SYSTEM.md`, files: [file(`${home}/.pi/agent/APPEND_SYSTEM.md`, short), s], skill: s.path };
  },
};

export const HERMES_CONTEXT: AgentContext = {
  conflict: ({ home }) => `[ -f ${home}/.hermes/config.yaml ] && awk ${shellQuote(HERMES_HINT_CHECK)} ${home}/.hermes/config.yaml`,
  hooks: ({ skill, source, roots: { etc, home }, conflict, fish }) => {
    const s = skillAt(`${home}/.hermes/skills`, skill);
    if (conflict) return { outcome: "not-loaded", note: "~/.hermes/config.yaml sets agent.environment_hint", files: [s], skill: s.path };
    const files: GuestFile[] = [file(`${etc}/profile.d/wsp-machine.sh`, `# ${CONTEXT_MARKER}\nexport HERMES_ENVIRONMENT_HINT="$(cat ${source})"\n`)];
    if (fish) files.push(file(`${etc}/fish/conf.d/wsp-machine.fish`, `# ${CONTEXT_MARKER}\nset -gx HERMES_ENVIRONMENT_HINT (cat ${source} | string collect)\n`));
    files.push(s);
    return { outcome: "written", path: files[0]!.path, files, skill: s.path };
  },
};
