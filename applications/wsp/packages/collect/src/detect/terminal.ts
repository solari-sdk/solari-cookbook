// SPDX-License-Identifier: AGPL-3.0-only
// The font the person's terminal draws with, read from its config, so the
// app's terminal pane can default to it. Nothing here travels to the machine.
import type { Host } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { exists } from "./common.js";
import { expand } from "../host.js";
import { GHOSTTY_BUILT_IN_FONT, parseGhosttyDirectives, readGhosttyConfig } from "../ghostty-config.js";

/** A family a config falls back to when it names none; not a font the pane can ask for. */
const GENERIC = new Set(["monospace", "mono", ""]);

const usable = (family: string | undefined): string | undefined => {
  const name = family?.trim().replace(/^["']|["']$/g, "").trim();
  return name === undefined || GENERIC.has(name.toLowerCase()) ? undefined : name;
};

/** Ghostty: the first font-family line is the primary face; an empty one resets the list. */
export function ghosttyFont(text: string): string | undefined {
  return primaryFace(parseGhosttyDirectives(text).filter(d => d.key === "font-family").map(d => d.value));
}

/** The first usable face of a font-family list; a generic word resets what came before it, as an empty line does. */
function primaryFace(families: readonly string[]): string | undefined {
  let kept: string[] = [];
  for (const family of families) {
    const value = usable(family);
    if (value === undefined) kept = [];
    else kept.push(value);
  }
  return kept[0];
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** iTerm2: the default bookmark's Normal Font, else the first bookmark's; the value is "<font name> <size>".
 * A bookmark's keys are written in sorted order, so its Guid precedes its Normal Font and the next Guid ends it. */
export function itermFont(xml: string): string | undefined {
  const guid = /<key>Default Bookmark Guid<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1];
  const at = guid === undefined ? -1 : xml.search(new RegExp(`<key>Guid</key>\\s*<string>${escapeRegExp(guid)}</string>`));
  const rest = at >= 0 ? xml.slice(at) : xml;
  const next = at >= 0 ? rest.indexOf("<key>Guid</key>", 1) : -1;
  const bookmark = next > 0 ? rest.slice(0, next) : rest;
  const font = /<key>Normal Font<\/key>\s*<string>([^<]*)<\/string>/.exec(bookmark)?.[1];
  return usable(font?.replace(/\s+[\d.]+$/, ""));
}

/** WezTerm: the family handed to wezterm.font or first in font_with_fallback, Lua comments skipped; unset, WezTerm draws with its bundled JetBrains Mono. */
export function weztermFont(lua: string): string | undefined {
  const live = lua.replace(/--\[\[[\s\S]*?\]\]/g, "").replace(/--.*$/gm, "");
  const m = /\bfont(?:_with_fallback)?\s*\(?\s*\{?\s*(?:\{\s*)?(?:family\s*=\s*)?(["'])([^"']+)\1/.exec(live);
  return usable(m?.[2]) ?? BUILT_IN;
}

/** kitty: font_family, in the bare form or the family="..." style="..." form. */
export function kittyFont(conf: string): string | undefined {
  const m = /^\s*font_family\s+(.+?)\s*$/m.exec(conf);
  if (m === null) return undefined;
  const value = m[1] ?? "";
  const keyed = /\bfamily\s*=\s*(?:"([^"]*)"|(\S+))/.exec(value);
  return usable(keyed !== null ? (keyed[1] ?? keyed[2]) : value);
}

/** Alacritty: font.normal.family in the toml forms or the older yaml. */
export function alacrittyFont(text: string): string | undefined {
  const toml =
    /\[font\.normal\][^[]*?^\s*family\s*=\s*"([^"]+)"/m.exec(text) ??
    /^\s*normal\s*=\s*\{[^}]*\bfamily\s*=\s*"([^"]+)"/m.exec(text) ??
    /^\s*normal\.family\s*=\s*"([^"]+)"/m.exec(text);
  if (toml !== null) return usable(toml[1]);
  const yaml = /^\s*normal:\s*\n(?:\s+(?!family:)\w+:.*\n)*\s+family:\s*(.+?)\s*$/m.exec(text);
  return usable(yaml?.[1]);
}

interface Terminal {
  key: string;
  name: string;
  /** TERM_PROGRAM values that name this terminal. */
  program: RegExp;
  /** The family the terminal ships with and draws with until a config says otherwise. */
  builtIn?: string;
  /** The family the terminal's config names; a config naming none answers the built-in default; no config answers nothing. */
  configured(host: Host): Promise<string | undefined>;
  /** Whether the terminal is on this computer, for a terminal with no config to answer its built-in default. */
  installed?(host: Host): Promise<boolean>;
}

async function firstText(host: Host, paths: readonly string[]): Promise<string | undefined> {
  for (const p of paths) {
    const text = await host.fs.readText(expand(host, p));
    if (text !== undefined) return text;
  }
  return undefined;
}

/** Ghostty and WezTerm both ship JetBrains Mono and draw with it until a config says otherwise. */
const BUILT_IN = GHOSTTY_BUILT_IN_FONT;

const TERMINALS: readonly Terminal[] = [
  {
    key: "ghostty",
    name: "Ghostty",
    program: /ghostty/i,
    builtIn: BUILT_IN,
    async configured(host) {
      const config = await readGhosttyConfig(host);
      return config.files.length === 0 ? undefined : (primaryFace(config.fontFamily) ?? BUILT_IN);
    },
    // On Linux it ships as a plain binary, so PATH is what says it is here; the .app bundle is the Mac's answer.
    installed: host => (host.platform === "darwin" ? exists(host, "/Applications/Ghostty.app") : host.exec.which("ghostty")),
  },
  {
    key: "iterm2",
    name: "iTerm2",
    program: /iterm/i,
    async configured(host) {
      // The plist is binary on disk; defaults renders the live preferences as XML.
      if (host.platform !== "darwin" || !(await exists(host, "~/Library/Preferences/com.googlecode.iterm2.plist"))) return undefined;
      const xml = await host.exec.run("defaults", ["export", "com.googlecode.iterm2", "-"]);
      return xml === undefined ? undefined : itermFont(xml);
    },
  },
  {
    key: "wezterm",
    name: "WezTerm",
    program: /wezterm/i,
    builtIn: BUILT_IN,
    async configured(host) {
      const lua = await firstText(host, ["~/.wezterm.lua", "~/.config/wezterm/wezterm.lua"]);
      return lua === undefined ? undefined : weztermFont(lua);
    },
  },
  {
    key: "kitty",
    name: "kitty",
    program: /kitty/i,
    async configured(host) {
      const conf = await firstText(host, ["~/.config/kitty/kitty.conf"]);
      return conf === undefined ? undefined : kittyFont(conf);
    },
  },
  {
    key: "alacritty",
    name: "Alacritty",
    program: /alacritty/i,
    async configured(host) {
      const text = await firstText(host, ["~/.config/alacritty/alacritty.toml", "~/.alacritty.toml", "~/.config/alacritty/alacritty.yml", "~/.alacritty.yml"]);
      return text === undefined ? undefined : alacrittyFont(text);
    },
  },
];

export const TERMINAL_FONT_ID = "shell/terminal-font";

const fontRow = (terminal: Terminal, font: string): ManifestEntry => ({ rung: "shell", id: TERMINAL_FONT_ID, label: `terminal font: ${font} (${terminal.name})`, paths: [], bytes: 0, default: "bring", font });

/** One row naming the family the person's terminal draws with: the terminal the collector runs in first (its
 * built-in default when it has no config), else the first terminal whose config names a usable font, else an
 * installed terminal's built-in default. No row when none answers. */
export async function detectTerminalFont(host: Host): Promise<ManifestEntry[]> {
  const own = TERMINALS.filter(t => host.terminal !== undefined && t.program.test(host.terminal));
  const others = TERMINALS.filter(t => !own.includes(t));
  for (const terminal of own) {
    const font = (await terminal.configured(host)) ?? terminal.builtIn;
    if (font !== undefined) return [fontRow(terminal, font)];
  }
  for (const terminal of others) {
    const font = await terminal.configured(host);
    if (font !== undefined) return [fontRow(terminal, font)];
  }
  for (const terminal of others) {
    if (terminal.builtIn !== undefined && (await terminal.installed?.(host)) === true) return [fontRow(terminal, terminal.builtIn)];
  }
  return [];
}
