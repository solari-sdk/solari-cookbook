// SPDX-License-Identifier: AGPL-3.0-only
// The theme registry and every theme's sheet: one module and one block per theme, every token declared once, and
// the floors measured from the values each file declares, so a theme that reads badly fails here before anyone
// looks at it.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DEFAULT_PREFERENCES } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { SIDE_DEFAULT, THEMES, themeById, themeFor } from "../src/themes/index.js";
import { blockBody, chroma, contrast, declarations, over, resolveColor, type Rgba } from "./css-color.js";

const DIR = join(__dirname, "../src/themes");
const indexCss = readFileSync(join(__dirname, "../src/index.css"), "utf8");
/** Tailwind's own palette, which the side tokens name by variable. */
const palette = new Map([...readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8").matchAll(/(--color-[\w-]+):\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]));

/** What every theme names, whichever side it draws. */
const TOKENS = [
  "color-scheme",
  "--background",
  "--foreground",
  "--card",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--primary",
  "--primary-foreground",
  "--border",
  "--input",
  "--success",
  "--warning",
  "--error-foreground",
  "--warning-foreground",
  "--success-foreground",
  "--info-foreground",
  "--update-foreground",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-muted-foreground",
  "--sidebar-whisper",
  "--sidebar-control-surface",
  "--sidebar-row-hover",
  "--sidebar-row-active",
  "--sidebar-row-selected",
  "--sidebar-row-edge",
  "--sidebar-rail",
  "--sidebar-stage-fade",
  "--sidebar-canvas",
  "--sidebar-card",
  "--sidebar-fill",
  "--sidebar-hover",
  "--sidebar-hover-ink",
  "--sidebar-quiet",
  "--sidebar-input",
] as const;
/** What a dark theme names besides: the Mac's dark window stands on the glass, and these are its grounds there. */
const DARK_TOKENS = ["--glass-ink", "--material-ground", "--material-raised", "--material-edge"] as const;
/** The tokens allowed a hue: the primary and the status inks. Everything else is a neutral. */
const HUED = new Set(["--primary", "--success", "--warning", "--error-foreground", "--warning-foreground", "--success-foreground", "--info-foreground", "--update-foreground"]);

const sheet = (id: string): string => readFileSync(join(DIR, `${id}.css`), "utf8");
const tokensOf = (id: string): Map<string, string> => new Map(declarations(blockBody(sheet(id), new RegExp(`\\[data-theme="${id}"\\][^{]*\\{`))!));

/** The side tokens the root declares for one side: the light set, with the dark arm over it on the dark side. */
function sideTokens(side: "light" | "dark"): Map<string, string> {
  const root = blockBody(indexCss, /:root,\n\[data-theme\] \{\n {2}--radius:/)!;
  const light = new Map(declarations(root));
  return side === "light" ? light : new Map([...light, ...declarations(blockBody(root, /@variant dark \{/)!)]);
}

function colours(id: string): (token: string) => Rgba {
  const theme = themeById(id)!;
  const own = tokensOf(id);
  const side = sideTokens(theme.side);
  const lookup = (name: string): string | undefined => own.get(name) ?? side.get(name) ?? palette.get(name);
  return token => resolveColor(token.startsWith("--") ? (lookup(token) ?? `var(${token})`) : token, lookup);
}

/** The Mac's dark window: its own declarations and the sidebar's inside it. */
const macWindow = new Map(declarations(blockBody(indexCss, /\.desktop-mac\.dark \{/)!));
const macSidebar = new Map(declarations(blockBody(blockBody(indexCss, /\.desktop-mac \[data-app-sidebar\] \{/)!, /@variant dark \{/)!));
/** The sidebar's own tiers, which the Mac's light sidebar lays over its veil on the glass. */
const sidebarTiers = new Map(declarations(blockBody(indexCss, /:root,\n\[data-app-sidebar\] \{/)!));
/** The glass read as mid grey: the dark glass over a white desktop, the lightest it shows, and the light glass over a
 * dark desktop, the darkest. */
const GLASS: Rgba = [128 / 255, 128 / 255, 128 / 255, 1];
/** The Mac's light window, where the sidebar alone stands on the glass under a veil of its own ground. */
const macLightWindow = new Map(declarations(blockBody(indexCss, /\.desktop-mac:not\(\.dark\) \{/) ?? ""));

describe("the theme registry", () => {
  it("ids are unique, each side's default is the record's default pick, and an id that is missing or on the other side reads as that side's default", () => {
    expect(new Set(THEMES.map(t => t.id)).size).toBe(THEMES.length);
    expect(SIDE_DEFAULT.light.id).toBe(DEFAULT_PREFERENCES.lightTheme);
    expect(SIDE_DEFAULT.dark.id).toBe(DEFAULT_PREFERENCES.darkTheme);
    expect(SIDE_DEFAULT.light.side).toBe("light");
    expect(SIDE_DEFAULT.dark.side).toBe("dark");
    expect(themeFor("dark", "no-such-theme")).toBe(SIDE_DEFAULT.dark);
    expect(themeFor("light", SIDE_DEFAULT.dark.id)).toBe(SIDE_DEFAULT.light);
    for (const t of THEMES) expect(themeFor(t.side, t.id)).toBe(t);
    for (const t of THEMES) expect(t.word.length * t.line.length).toBeGreaterThan(0);
  });

  it("the set is three light themes and five dark, each side led by its default", () => {
    expect(THEMES.map(t => `${t.side}:${t.id}`)).toEqual(["light:paper", "light:linen", "light:frost", "dark:graphite", "dark:denim", "dark:tungsten", "dark:moss", "dark:pitch"]);
  });

  it("each theme is one module importing its own sheet, and the sheets on disk are the registered ones", () => {
    const sheets = readdirSync(DIR).filter(f => f.endsWith(".css")).map(f => f.slice(0, -4)).sort();
    expect(sheets).toEqual(THEMES.map(t => t.id).sort());
    for (const t of THEMES) expect(readFileSync(join(DIR, `${t.id}.ts`), "utf8")).toContain(`import "./${t.id}.css";`);
  });

  it("every page that loads the stylesheet loads the theme registry, since no colour token lives outside a theme's sheet", () => {
    const harnesses = readdirSync(__dirname, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => readdirSync(join(__dirname, d.name)).filter(f => /^main\.tsx?$/.test(f)).map(f => join(__dirname, d.name, f)));
    const entries = [join(__dirname, "../src/main.tsx"), ...harnesses];
    const styled = entries.filter(f => /^import ["'][./]*(src\/)?index\.css["'];/m.test(readFileSync(f, "utf8")));
    expect(styled.length).toBeGreaterThan(2);
    expect(styled.filter(f => !/^import [^;]*["'][./]*(src\/)?(themes\/index|settings\/theme)(\.js)?["'];/m.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("a page carrying no theme mark draws each side's default, and the page that boots before the app names no theme of its own", () => {
    for (const t of THEMES) {
      const header = /^([^{]+)\{/m.exec(sheet(t.id).replace(/\/\*[\s\S]*?\*\//g, ""))![1]!.trim();
      const fallback = t.side === "light" ? ":root:not([data-theme])" : ":root.dark:not([data-theme])";
      expect(header.includes(fallback)).toBe(SIDE_DEFAULT[t.side] === t);
    }
    const index = readFileSync(join(__dirname, "../index.html"), "utf8");
    expect(index).toMatch(/<html lang="en" class="dark">/);
  });
});

describe.each(THEMES.map(t => [t.id, t] as const))("the %s theme", (id, theme) => {
  const c = colours(id);
  const ratio = (ink: string, ground: string, under?: string): number => {
    const g = under === undefined ? c(ground) : over(c(ground), c(under));
    return contrast(c(ink), g);
  };

  it("declares every token its side needs, each once, and the colour scheme of its side", () => {
    const decls = declarations(blockBody(sheet(id), new RegExp(`\\[data-theme="${id}"\\][^{]*\\{`))!).map(([n]) => n);
    const needed = theme.side === "dark" ? [...TOKENS, ...DARK_TOKENS] : TOKENS;
    expect(decls.filter((n, i) => decls.indexOf(n) !== i)).toEqual([]);
    expect([...decls].sort()).toEqual([...needed].sort());
    expect(tokensOf(id).get("color-scheme")).toBe(theme.side);
  });

  it("body and muted text read at AA on the ground and the card, and the quiet sidebar inks on the sidebar", () => {
    expect(ratio("--foreground", "--background")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--foreground", "--card", "--background")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--muted-foreground", "--background")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--muted-foreground", "--card", "--background")).toBeGreaterThanOrEqual(4.5);
    for (const ink of ["--sidebar-foreground", "--sidebar-muted-foreground", "--sidebar-whisper", "--sidebar-quiet", sidebarTiers.get("--sidebar-prose")!]) expect(ratio(ink, "--sidebar"), ink).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--accent-foreground", "--accent", "--background")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--sidebar-hover-ink", "--sidebar-hover", "--sidebar")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--muted-foreground", "--accent", "--background")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--sidebar-quiet", "--sidebar-hover", "--sidebar")).toBeGreaterThanOrEqual(4.5);
  });

  it.skipIf(theme.side !== "dark")("in the Mac's window, muted text and the chat's links in the chat column, the right panel and the sidebar reads at AA over its share of the glass under a hover fill", () => {
    const share = (region: string): Rgba => over(c(`color-mix(in srgb, var(--material-ground) ${macWindow.get(region)!}, transparent)`), GLASS);
    const regions = [
      { region: "--material-centre", inks: [macWindow.get("--muted-foreground")!, "--info-foreground"], fills: ["--accent"] },
      { region: "--material-panel", inks: [macWindow.get("--muted-foreground")!], fills: ["--accent"] },
      { region: "--material-sidebar", inks: ["--sidebar-foreground", ...["--sidebar-muted-foreground", "--muted-foreground", "--sidebar-row-rest", "--sidebar-prose"].map(t => macSidebar.get(t)!)], fills: ["--sidebar-row-hover", "--sidebar-row-selected"] },
    ];
    for (const { region, inks, fills } of regions) {
      for (const ink of inks) for (const fill of fills) expect(contrast(c(ink), over(c(fill), share(region))), `${ink} on ${fill} in ${region}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.skipIf(theme.side !== "dark")("in the Mac's window a row's name stands a step brighter than the sidebar's quiet ink, which the glass lifts", () => {
    expect(ratio("--sidebar-foreground", "--glass-ink")).toBeGreaterThanOrEqual(1.1);
  });

  it.skipIf(theme.side !== "light")("in the Mac's light window every sidebar ink reads at AA over the veil on the glass over a dark desktop, where the glass reads as mid grey", () => {
    const ground = over(c(`color-mix(in srgb, var(--sidebar) ${macLightWindow.get("--sidebar-veil") ?? "0%"}, transparent)`), GLASS);
    for (const ink of ["--sidebar-foreground", "--sidebar-muted-foreground", "--sidebar-quiet", sidebarTiers.get("--sidebar-row-rest")!, sidebarTiers.get("--sidebar-prose")!]) {
      expect(contrast(c(ink), ground), ink).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the primary's label reads on it, the primary reads as a graphic on the ground, and every status ink reads on the card", () => {
    expect(ratio("--primary-foreground", "--primary")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("--primary", "--background")).toBeGreaterThanOrEqual(3);
    for (const fill of ["--error", "--warning", "--success", "--info"]) expect(ratio(fill, "--card", "--background"), fill).toBeGreaterThanOrEqual(3);
    for (const ink of ["--error-foreground", "--warning-foreground", "--success-foreground", "--info-foreground", "--update-foreground", "--caution-foreground", "--yellow-foreground"]) {
      expect(ratio(ink, "--card", "--background"), ink).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the border stands off the ground and the tree's rails off the sidebar", () => {
    expect(ratio("--border", "--background")).toBeGreaterThanOrEqual(1.15);
    expect(ratio("--sidebar-rail", "--sidebar")).toBeGreaterThanOrEqual(1.3);
  });

  it("every neutral stays under 0.035 of chroma, so hue lives in the ground's temperature and the primary", () => {
    for (const token of TOKENS) {
      if (token === "color-scheme" || HUED.has(token)) continue;
      expect(chroma(c(token)), token).toBeLessThan(0.035);
    }
  });

  it("every ANSI slot the pane falls back to reads at 4.8 on this theme's ground", () => {
    for (let slot = 0; slot < 16; slot++) expect(ratio(`--terminal-ansi-${slot}`, "--background"), `slot ${slot}`).toBeGreaterThanOrEqual(4.8);
  });
});
