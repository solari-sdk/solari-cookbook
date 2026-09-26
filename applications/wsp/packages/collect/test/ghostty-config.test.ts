// SPDX-License-Identifier: AGPL-3.0-only
// The person's Ghostty config as the terminal pane takes it: Ghostty's own
// lookup order and include rules over a laptop described as data, the theme
// resolved against the theme directories and the bundled themes, and only the
// keys the pane honours in the answer.
import { describe, expect, it } from "vitest";
import { ghosttyFont, parseGhosttyDirectives, readGhosttyConfig } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

const rgb = (hex: string) => ({ r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) });
const NONE = Array<null>(16).fill(null);

/** Catppuccin Mocha as Ghostty ships it, word for word. */
const MOCHA = `palette = 0=#45475a
palette = 1=#f38ba8
palette = 2=#a6e3a1
palette = 3=#f9e2af
palette = 4=#89b4fa
palette = 5=#f5c2e7
palette = 6=#94e2d5
palette = 7=#a6adc8
palette = 8=#585b70
palette = 9=#f37799
palette = 10=#89d88b
palette = 11=#ebd391
palette = 12=#74a8fc
palette = 13=#f2aede
palette = 14=#6bd7ca
palette = 15=#bac2de
background = #1e1e2e
foreground = #cdd6f4
cursor-color = #f5e0dc
cursor-text = #1e1e2e
selection-background = #585b70
selection-foreground = #cdd6f4
`;
const BUNDLED = "/Applications/Ghostty.app/Contents/Resources/ghostty/themes";

describe("parseGhosttyDirectives", () => {
  it("reads key = value lines in order, keeps repeats, strips quotes, skips blanks and comments, and keeps a # inside a value", () => {
    expect(parseGhosttyDirectives('# a comment\n\nfont-family = "Berkeley Mono"\nfont-family = Symbols Nerd Font\n  theme=Catppuccin Mocha  \nbackground = #1e1e2e\nnot-a-line\n')).toEqual([
      { key: "font-family", value: "Berkeley Mono" },
      { key: "font-family", value: "Symbols Nerd Font" },
      { key: "theme", value: "Catppuccin Mocha" },
      { key: "background", value: "#1e1e2e" },
    ]);
  });
});

describe("readGhosttyConfig", () => {
  it("with no config file answers the empty object: no files, no font, sixteen unset palette slots, no other key", async () => {
    expect(await readGhosttyConfig(fakeHost({ files: { "~/.zshrc": 10 } }))).toEqual({ files: [], fontFamily: [], palette: NONE });
  });

  it("takes every key the pane honours from a real config, ignores the ones it does not, and lets the file's own colors beat the theme's", async () => {
    const config = `theme = Catppuccin Mocha
font-family = "Berkeley Mono"
font-family = Symbols Nerd Font Mono
font-size = 13.5
background = #000000
palette = 0x1=#ff0000
palette = 16=#123456
cursor-color = cell-foreground
cursor-style = underline
cursor-style-blink = false
window-padding-x = 2,4
window-padding-y = 6
background-opacity = 0.85
background-blur-radius = 20
selection-foreground = navy
keybind = ctrl+a=copy_to_clipboard
mouse-hide-while-typing = true
`;
    const host = fakeHost({ files: { "~/.config/ghostty/config": config, [`${BUNDLED}/Catppuccin Mocha`]: MOCHA } });
    expect(await readGhosttyConfig(host)).toEqual({
      files: ["/Users/dev/.config/ghostty/config", `${BUNDLED}/Catppuccin Mocha`],
      fontFamily: ["Berkeley Mono", "Symbols Nerd Font Mono"],
      fontSize: 13.5,
      theme: "Catppuccin Mocha",
      background: rgb("000000"),
      foreground: rgb("cdd6f4"),
      // 0x1 is slot one in Ghostty's own notation, so the theme's slot zero stands and its slot one is replaced.
      palette: [rgb("45475a"), rgb("ff0000"), ...["a6e3a1", "f9e2af", "89b4fa", "f5c2e7", "94e2d5", "a6adc8", "585b70", "f37799", "89d88b", "ebd391", "74a8fc", "f2aede", "6bd7ca", "bac2de"].map(rgb)],
      selectionBackground: rgb("585b70"),
      // cell-foreground is a color the pane cannot resolve, so the theme's cursor stands.
      cursorColor: rgb("f5e0dc"),
      cursorStyle: "underline",
      cursorStyleBlink: false,
      windowPaddingX: { left: 2, right: 4 },
      windowPaddingY: { top: 6, bottom: 6 },
      backgroundOpacity: 0.85,
      backgroundBlur: 20,
    });
  });

  it("an empty font-family resets the list, a bare hex color and true for the blur are read, and a value nothing can parse leaves the key unset", async () => {
    const config = 'font-family = Menlo\nfont-family = ""\nfont-family = Iosevka\nforeground = CDD6F4\nbackground-blur = true\nbackground-opacity = lots\ncursor-style = wobble\nfont-size = big\n';
    expect(await readGhosttyConfig(fakeHost({ files: { "~/.config/ghostty/config": config } }))).toEqual({
      files: ["/Users/dev/.config/ghostty/config"],
      fontFamily: ["Iosevka"],
      foreground: rgb("cdd6f4"),
      palette: NONE,
      backgroundBlur: 20,
    });
  });

  it("follows config-file includes after the file that names them, relative to it, an optional one missing quietly, a cycle once", async () => {
    const files = {
      "~/.config/ghostty/config": "config-file = colors\nconfig-file = ?absent\nfont-size = 12\n",
      "~/.config/ghostty/colors": "font-size = 15\nconfig-file = ../ghostty/config\nbackground = #101010\n",
    };
    expect(await readGhosttyConfig(fakeHost({ files }))).toEqual({
      files: ["/Users/dev/.config/ghostty/config", "/Users/dev/.config/ghostty/colors"],
      fontFamily: [],
      fontSize: 15,
      background: rgb("101010"),
      palette: NONE,
    });
  });

  it("loads config.ghostty then config under XDG, then the Application Support pair the same way, the later file winning, and honours XDG_CONFIG_HOME", async () => {
    // Ghostty's config reference (ghostty.org/docs/config, File Location) lists config.ghostty before config in each
    // folder and says conflicting values in later files override earlier ones, so a plain config beside a renamed one
    // wins, and the Mac's Application Support pair wins over the XDG pair.
    const files = {
      "~/.config/ghostty/config.ghostty": "font-size = 20\nbackground = #222222\n",
      "~/.config/ghostty/config": "font-size = 10\nbackground = #111111\n",
      "~/Library/Application Support/com.mitchellh.ghostty/config.ghostty": "font-size = 13\n",
      "~/Library/Application Support/com.mitchellh.ghostty/config": "font-size = 12\n",
    };
    expect(await readGhosttyConfig(fakeHost({ files }))).toMatchObject({
      files: [
        "/Users/dev/.config/ghostty/config.ghostty",
        "/Users/dev/.config/ghostty/config",
        "/Users/dev/Library/Application Support/com.mitchellh.ghostty/config.ghostty",
        "/Users/dev/Library/Application Support/com.mitchellh.ghostty/config",
      ],
      fontSize: 12,
      background: rgb("111111"),
    });
    expect(await readGhosttyConfig(fakeHost({ platform: "linux", files }))).toMatchObject({ files: ["/Users/dev/.config/ghostty/config.ghostty", "/Users/dev/.config/ghostty/config"], fontSize: 10 });
    const xdg = fakeHost({ xdgConfigHome: "/Users/dev/cfg", files: { "/Users/dev/cfg/ghostty/config": "font-size = 9\n", "~/.config/ghostty/config": "font-size = 11\n" } });
    expect(await readGhosttyConfig(xdg)).toMatchObject({ files: ["/Users/dev/cfg/ghostty/config"], fontSize: 9 });
  });

  it("resolves a theme against the config's themes folder before the bundled ones, takes an absolute path as is, picks light or dark by scheme, and ignores theme and config-file inside a theme", async () => {
    const files = {
      "~/.config/ghostty/config": "theme = light:Mine,dark:Catppuccin Mocha\n",
      "~/.config/ghostty/themes/Mine": "background = #fafafa\ntheme = Catppuccin Mocha\nconfig-file = ../config\n",
      [`${BUNDLED}/Mine`]: "background = #bad000\n",
      [`${BUNDLED}/Catppuccin Mocha`]: MOCHA,
      "/tmp/own": "foreground = #abcdef\n",
    };
    expect(await readGhosttyConfig(fakeHost({ files }), "light")).toMatchObject({ files: ["/Users/dev/.config/ghostty/config", "/Users/dev/.config/ghostty/themes/Mine"], theme: "Mine", background: rgb("fafafa") });
    expect(await readGhosttyConfig(fakeHost({ files }), "dark")).toMatchObject({ theme: "Catppuccin Mocha", background: rgb("1e1e2e") });
    expect(await readGhosttyConfig(fakeHost({ files }))).toMatchObject({ theme: "Catppuccin Mocha" });
    const absolute = fakeHost({ files: { ...files, "~/.config/ghostty/config": "theme = /tmp/own\n" } });
    expect(await readGhosttyConfig(absolute)).toMatchObject({ files: ["/Users/dev/.config/ghostty/config", "/tmp/own"], theme: "/tmp/own", foreground: rgb("abcdef") });
    // Ghostty looks in the config's themes folder and the bundled ones only; a theme left in Application Support is not found.
    const appSupportOnly = fakeHost({ files: { "~/.config/ghostty/config": "theme = Stray\n", "~/Library/Application Support/com.mitchellh.ghostty/themes/Stray": "background = #010203\n" } });
    expect(await readGhosttyConfig(appSupportOnly)).toEqual({ files: ["/Users/dev/.config/ghostty/config"], fontFamily: [], theme: "Stray", palette: NONE });
    // A theme nobody has is no theme: the name is kept so the person can see what was asked for.
    const missing = fakeHost({ files: { "~/.config/ghostty/config": "theme = Nope\n" } });
    expect(await readGhosttyConfig(missing)).toEqual({ files: ["/Users/dev/.config/ghostty/config"], fontFamily: [], theme: "Nope", palette: NONE });
  });

  it("is the one Ghostty reader: the terminal font detector's primary face comes from the same directives", () => {
    expect(ghosttyFont('font-family = "Berkeley Mono"\nfont-family = Symbols Nerd Font\n')).toBe("Berkeley Mono");
  });
});
