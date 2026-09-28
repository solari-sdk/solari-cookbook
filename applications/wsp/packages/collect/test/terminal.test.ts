// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { alacrittyFont, detectTerminalFont, ghosttyFont, itermFont, kittyFont, weztermFont } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

/** As defaults export writes it: every key on its own line, its value on the next. */
const ITERM_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>Default Bookmark Guid</key>
	<string>B-2</string>
	<key>New Bookmarks</key>
	<array>
		<dict>
			<key>Guid</key>
			<string>B-1</string>
			<key>Name</key>
			<string>Default</string>
			<key>Normal Font</key>
			<string>Monaco 12</string>
		</dict>
		<dict>
			<key>Background Color</key>
			<dict>
				<key>Red Component</key>
				<real>0</real>
			</dict>
			<key>Guid</key>
			<string>B-2</string>
			<key>Name</key>
			<string>Work</string>
			<key>Normal Font</key>
			<string>JetBrainsMonoNF-Regular 13</string>
		</dict>
	</array>
</dict>
</plist>`;

describe("terminal font parsers", () => {
  it.each([
    ["font-family = JetBrains Mono\nfont-size = 16\n", "JetBrains Mono"],
    ['font-family = "Berkeley Mono"\n', "Berkeley Mono"],
    ["# font-family = Commented\nfont-family = Hack Nerd Font Mono\nfont-family = Symbols Nerd Font\n", "Hack Nerd Font Mono"],
    ["font-family = Menlo\nfont-family = \nfont-family = Iosevka\n", "Iosevka"],
    ["font-size = 16\n", undefined],
  ])("ghostty: %j", (text, family) => {
    expect(ghosttyFont(text)).toBe(family);
  });

  it("iterm2: the default bookmark's Normal Font without its size, else the first bookmark's", () => {
    expect(itermFont(ITERM_PLIST)).toBe("JetBrainsMonoNF-Regular");
    expect(itermFont(ITERM_PLIST.replace("<key>Default Bookmark Guid</key>\n\t<string>B-2</string>", ""))).toBe("Monaco");
    expect(itermFont(ITERM_PLIST.replace("<string>B-2</string>\n\t<key>New", "<string>B-9</string>\n\t<key>New"))).toBe("Monaco");
    expect(itermFont("<plist><dict></dict></plist>")).toBeUndefined();
  });

  it.each([
    ['config.font = wezterm.font("Fira Code")\n', "Fira Code"],
    ["config.font = wezterm.font('Iosevka Term', { weight = 'Bold' })\n", "Iosevka Term"],
    ['config.font = wezterm.font({ family = "Cascadia Code", weight = "DemiBold" })\n', "Cascadia Code"],
    ["config.font = wezterm.font { family = 'Monaspace Neon' }\n", "Monaspace Neon"],
    ['config.font = wezterm.font_with_fallback({ "Victor Mono", "Symbols Nerd Font Mono" })\n', "Victor Mono"],
    ['config.font = wezterm.font_with_fallback { { family = "Recursive Mono", weight = "Medium" }, "Noto Color Emoji" }\n', "Recursive Mono"],
    ["config.font_size = 14\n", "JetBrains Mono"],
    ['-- config.font = wezterm.font("Old")\nconfig.font = wezterm.font("Fira Code")\n', "Fira Code"],
    ['--[[\nconfig.font = wezterm.font("Old")\n]]\nconfig.font = wezterm.font("Fira Code") -- was wezterm.font("Older")\n', "Fira Code"],
    ['-- config.font = wezterm.font("Old")\n', "JetBrains Mono"],
  ])("wezterm: %j", (text, family) => {
    expect(weztermFont(text)).toBe(family);
  });

  it.each([
    ["font_family      Fira Code Retina\nbold_font auto\n", "Fira Code Retina"],
    ['font_family family="Iosevka Term" style="Medium"\n', "Iosevka Term"],
    ["font_family family=Hack\n", "Hack"],
    ["# font_family Menlo\nfont_size 13\n", undefined],
    ["font_family monospace\n", undefined],
  ])("kitty: %j", (text, family) => {
    expect(kittyFont(text)).toBe(family);
  });

  it.each([
    ['[font.normal]\nfamily = "Fira Code"\nstyle = "Retina"\n', "Fira Code"],
    ['[font]\nsize = 13\nnormal = { family = "Hack", style = "Regular" }\n', "Hack"],
    ['[font]\nnormal.family = "Iosevka"\n', "Iosevka"],
    ["font:\n  size: 13\n  normal:\n    family: Fira Code\n    style: Regular\n", "Fira Code"],
    ['font:\n  normal:\n    family: "Hack Nerd Font"\n', "Hack Nerd Font"],
    ['[font]\nsize = 13\n', undefined],
    ['[font.normal]\nfamily = "monospace"\n', undefined],
  ])("alacritty: %j", (text, family) => {
    expect(alacrittyFont(text)).toBe(family);
  });
});

describe("terminal font row", () => {
  const row = (font: string, label: string) => ({ rung: "shell", id: "shell/terminal-font", label, paths: [], bytes: 0, default: "bring", font });

  it("ghostty with no font-family, or with no config at all when it is the running terminal or installed, draws with its built-in JetBrains Mono", async () => {
    const jetbrains = [row("JetBrains Mono", "terminal font: JetBrains Mono (Ghostty)")];
    expect(await detectTerminalFont(fakeHost({ files: { "~/.config/ghostty/config": "font-size = 16\n" } }))).toEqual(jetbrains);
    expect(await detectTerminalFont(fakeHost({ terminal: "ghostty", files: { "~/.zshrc": 10 } }))).toEqual(jetbrains);
    expect(await detectTerminalFont(fakeHost({ files: { "/Applications/Ghostty.app/": 5000 } }))).toEqual(jetbrains);
    expect(await detectTerminalFont(fakeHost({ platform: "linux", files: { "/Applications/Ghostty.app/": 5000 } }))).toEqual([]);
    // The running terminal's default beats another terminal's config.
    const iterm = { files: { "~/Library/Preferences/com.googlecode.iterm2.plist": 4000 }, exec: { "defaults export com.googlecode.iterm2 -": ITERM_PLIST } };
    expect(await detectTerminalFont(fakeHost({ ...iterm, terminal: "ghostty" }))).toEqual(jetbrains);
    expect(await detectTerminalFont(fakeHost({ ...iterm, terminal: "WezTerm" }))).toEqual([row("JetBrains Mono", "terminal font: JetBrains Mono (WezTerm)")]);
  });

  it("Ghostty on a Linux computer with no config draws with the same built-in font, found on PATH rather than in /Applications", async () => {
    const jetbrains = [row("JetBrains Mono", "terminal font: JetBrains Mono (Ghostty)")];
    expect(await detectTerminalFont(fakeHost({ platform: "linux", which: ["ghostty"], files: { "~/.zshrc": 10 } }))).toEqual(jetbrains);
    // Nothing of Ghostty there is no row, as a Mac without it has none.
    expect(await detectTerminalFont(fakeHost({ platform: "linux", files: { "~/.zshrc": 10 } }))).toEqual([]);
  });

  it("with no running terminal known, a config that names a font beats an installed terminal's default", async () => {
    const ghosttyApp = { "/Applications/Ghostty.app/": 5000 };
    const iterm = { files: { ...ghosttyApp, "~/Library/Preferences/com.googlecode.iterm2.plist": 4000 }, exec: { "defaults export com.googlecode.iterm2 -": ITERM_PLIST } };
    expect(await detectTerminalFont(fakeHost(iterm))).toEqual([row("JetBrainsMonoNF-Regular", "terminal font: JetBrainsMonoNF-Regular (iTerm2)")]);
    const kitty = fakeHost({ files: { ...ghosttyApp, "~/.config/kitty/kitty.conf": "font_family Fira Code\n" } });
    expect(await detectTerminalFont(kitty)).toEqual([row("Fira Code", "terminal font: Fira Code (kitty)")]);
    // A Ghostty config, even one naming no font, says Ghostty is in use.
    const configured = fakeHost({ files: { ...ghosttyApp, "~/.config/ghostty/config": "font-size = 16\n", "~/.config/kitty/kitty.conf": "font_family Fira Code\n" } });
    expect(await detectTerminalFont(configured)).toEqual([row("JetBrains Mono", "terminal font: JetBrains Mono (Ghostty)")]);
  });

  it("reads Ghostty's macOS config location and prefers the one under ~/.config", async () => {
    const mac = await detectTerminalFont(fakeHost({ files: { "~/Library/Application Support/com.mitchellh.ghostty/config": "font-family = Iosevka\n" } }));
    expect(mac[0]).toMatchObject({ font: "Iosevka" });
    const both = await detectTerminalFont(fakeHost({ files: { "~/.config/ghostty/config": "font-family = Hack\n", "~/Library/Application Support/com.mitchellh.ghostty/config": "font-family = Iosevka\n" } }));
    expect(both[0]).toMatchObject({ font: "Hack" });
  });

  it("the terminal the collector runs in wins over the others' configs", async () => {
    const files = { "~/.config/ghostty/config": "font-family = Hack\n", "~/.config/kitty/kitty.conf": "font_family Fira Code\n", "~/Library/Preferences/com.googlecode.iterm2.plist": 4000 };
    const exec = { "defaults export com.googlecode.iterm2 -": ITERM_PLIST };
    expect(await detectTerminalFont(fakeHost({ files, exec }))).toEqual([row("Hack", "terminal font: Hack (Ghostty)")]);
    expect(await detectTerminalFont(fakeHost({ files, exec, terminal: "iTerm.app" }))).toEqual([row("JetBrainsMonoNF-Regular", "terminal font: JetBrainsMonoNF-Regular (iTerm2)")]);
    const kitty = await detectTerminalFont(fakeHost({ files, exec, terminal: "kitty" }));
    expect(kitty).toEqual([row("Fira Code", "terminal font: Fira Code (kitty)")]);
  });

  it("iTerm2's plist is read through defaults, never as a file, and only on a Mac", async () => {
    const host = fakeHost({ files: { "~/Library/Preferences/com.googlecode.iterm2.plist": 4000 }, exec: { "defaults export com.googlecode.iterm2 -": ITERM_PLIST } });
    expect(await detectTerminalFont(host)).toEqual([row("JetBrainsMonoNF-Regular", "terminal font: JetBrainsMonoNF-Regular (iTerm2)")]);
    expect(host.calls).not.toContain("read /Users/dev/Library/Preferences/com.googlecode.iterm2.plist");
    const linux = fakeHost({ platform: "linux", files: { "~/Library/Preferences/com.googlecode.iterm2.plist": 4000 }, exec: { "defaults export com.googlecode.iterm2 -": ITERM_PLIST } });
    expect(await detectTerminalFont(linux)).toEqual([]);
  });

  it("wezterm, kitty and alacritty configs each name the row after their terminal", async () => {
    expect(await detectTerminalFont(fakeHost({ files: { "~/.wezterm.lua": 'config.font = wezterm.font("Fira Code")\n' } }))).toEqual([row("Fira Code", "terminal font: Fira Code (WezTerm)")]);
    expect(await detectTerminalFont(fakeHost({ files: { "~/.config/wezterm/wezterm.lua": "return {}\n" } }))).toEqual([row("JetBrains Mono", "terminal font: JetBrains Mono (WezTerm)")]);
    expect(await detectTerminalFont(fakeHost({ files: { "~/.config/alacritty/alacritty.toml": '[font.normal]\nfamily = "Hack"\n' } }))).toEqual([row("Hack", "terminal font: Hack (Alacritty)")]);
    expect(await detectTerminalFont(fakeHost({ files: { "~/.alacritty.yml": "font:\n  normal:\n    family: Hack\n" } }))).toEqual([row("Hack", "terminal font: Hack (Alacritty)")]);
  });

  it("a terminal whose config names no usable font is passed over for the next one; none known means no row", async () => {
    const rows = await detectTerminalFont(fakeHost({ files: { "~/.config/kitty/kitty.conf": "font_size 13\n", "~/.config/alacritty/alacritty.toml": '[font.normal]\nfamily = "Hack"\n' } }));
    expect(rows).toEqual([row("Hack", "terminal font: Hack (Alacritty)")]);
    expect(await detectTerminalFont(fakeHost({ files: { "~/.zshrc": 10 } }))).toEqual([]);
  });
});
