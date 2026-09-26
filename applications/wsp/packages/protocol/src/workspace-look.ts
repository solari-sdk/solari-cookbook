// SPDX-License-Identifier: AGPL-3.0-only
// The look a person gives one workspace: a theme and a glyph. The theme is one
// object on the record, colour dots on a wheel with the grain, the opacity and
// the scheme they render under; the glyphs are names of the app's own icons,
// never emoji, since emoji draw differently on every platform and the app's
// chrome carries none. The maths that turns a dot into a colour and the dots
// into the sidebar's gradient lives here too, so the picker that shows a
// preview and the sidebar that paints the result cannot drift apart. The shape
// follows the Zen browser's theme picker: hue by angle, lightness by distance
// from the centre, the dots after the first placed by a colour harmony at the
// first one's radius.
import { z } from "zod";

/** The glyphs offered, in the order the picker shows them; each id names one icon of the app's set. */
export const WORKSPACE_GLYPHS = [
  "terminal",
  "code",
  "bug",
  "wrench",
  "hammer",
  "rocket",
  "flask",
  "database",
  "cloud",
  "globe",
  "compass",
  "map",
  "book",
  "feather",
  "palette",
  "leaf",
  "star",
  "bolt",
  "key",
  "shield",
  "box",
  "folder",
  "chip",
  "lamp",
] as const;
export const WorkspaceGlyph = z.enum(WORKSPACE_GLYPHS);
export type WorkspaceGlyph = z.infer<typeof WorkspaceGlyph>;

/** One colour dot on the picker's wheel: its hue is the angle in degrees, its lightness the distance from the
 * centre, 0 at the centre and 1 at the rim. */
export const ThemeDot = z.object({ angle: z.number().min(0).max(360), radius: z.number().min(0).max(1) });
export type ThemeDot = z.infer<typeof ThemeDot>;

/** How the dots after the first sit against it, by the angles they keep from it around the wheel. The first dot is
 * the one a person drags; the others follow at its radius. A harmony with no angles is one dot alone. */
export const THEME_HARMONIES = ["single", "complementary", "analogous", "splitComplementary", "triadic", "analogousThree"] as const;
export const ThemeHarmony = z.enum(THEME_HARMONIES);
export type ThemeHarmony = z.infer<typeof ThemeHarmony>;

const HARMONY_ANGLES: Record<ThemeHarmony, ReadonlyArray<number>> = {
  single: [],
  complementary: [180],
  analogous: [310],
  splitComplementary: [150, 210],
  triadic: [120, 240],
  analogousThree: [50, 310],
};

/** The dots a harmony places, the first included. */
export const harmonySize = (harmony: ThemeHarmony): number => HARMONY_ANGLES[harmony].length + 1;

/** The harmonies that place this many dots, in the order the picker cycles them. */
export function harmoniesOf(count: number): ThemeHarmony[] {
  return THEME_HARMONIES.filter(harmony => harmonySize(harmony) === count);
}

export const THEME_MAX_DOTS = 3;

/** Which side the theme renders under: the app's own, or one side pinned for this workspace alone. */
export const ThemeMode = z.enum(["auto", "light", "dark"]);
export type ThemeMode = z.infer<typeof ThemeMode>;

/** The least of the colour the opacity slider leaves; below it the sidebar would read as untinted with a theme set. */
export const THEME_MIN_OPACITY = 0.1;
/** The grain slider's steps, so two picks a hair apart draw the same tile. */
export const THEME_GRAIN_STEPS = 16;

export const WorkspaceTheme = z.object({
  dots: z.array(ThemeDot).min(1).max(THEME_MAX_DOTS),
  harmony: ThemeHarmony,
  /** How much grain lies over the gradient, 0 for none. */
  grain: z.number().min(0).max(1),
  /** How much of the colour shows over the sidebar's own surface. */
  opacity: z.number().min(THEME_MIN_OPACITY).max(1),
  mode: ThemeMode,
});
export type WorkspaceTheme = z.infer<typeof WorkspaceTheme>;

/** What one call changes: a key left out keeps that fact as it is, and null clears it back to none. */
export const WorkspaceLook = z.object({
  theme: WorkspaceTheme.nullable().optional(),
  glyph: WorkspaceGlyph.nullable().optional(),
});
export type WorkspaceLook = z.infer<typeof WorkspaceLook>;

/** Which of the two facts a picker or a menu entry is for. */
export type LookPart = keyof WorkspaceLook;

/** The two in the order every menu shows them. */
export const LOOK_PARTS = ["glyph", "theme"] as const satisfies ReadonlyArray<LookPart>;

/** The dots a harmony places around the first, at its radius; the first stays where it is. */
export function harmonyDots(first: ThemeDot, harmony: ThemeHarmony): ThemeDot[] {
  return [first, ...HARMONY_ANGLES[harmony].map(offset => ({ angle: (first.angle + offset) % 360, radius: first.radius }))];
}

/** The theme with its first dot moved: the others follow the harmony. */
export function moveFirstDot(theme: WorkspaceTheme, first: ThemeDot): WorkspaceTheme {
  return { ...theme, dots: harmonyDots(first, theme.harmony) };
}

/** The theme with one dot more or fewer: the next harmony of that size, with its dots placed. Null where the count
 * cannot move that way. */
export function resizeDots(theme: WorkspaceTheme, step: 1 | -1): WorkspaceTheme | null {
  const harmony = harmoniesOf(theme.dots.length + step)[0];
  return harmony === undefined ? null : { ...theme, harmony, dots: harmonyDots(theme.dots[0]!, harmony) };
}

/** The theme under the next harmony that places as many dots, wrapping. */
export function cycleHarmony(theme: WorkspaceTheme): WorkspaceTheme {
  const choices = harmoniesOf(theme.dots.length);
  const harmony = choices[(choices.indexOf(theme.harmony) + 1) % choices.length] ?? theme.harmony;
  return { ...theme, harmony, dots: harmonyDots(theme.dots[0]!, harmony) };
}

/** A grain value on the slider's steps. */
export const snapGrain = (grain: number): number => Math.round(Math.min(1, Math.max(0, grain)) * THEME_GRAIN_STEPS) / THEME_GRAIN_STEPS;

export type Rgb = readonly [number, number, number];

/** The colour a dot stands for: hue by angle, lightness by distance from the centre (black at the centre, white at
 * the rim), saturation near full and a little fuller toward the rim. */
export function dotColour(dot: ThemeDot): Rgb {
  return hslToRgb(dot.angle / 360, 0.9 + 0.1 * dot.radius, dot.radius);
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const grey = Math.round(l * 255);
    return [grey, grey, grey];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    const u = ((t % 1) + 1) % 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [Math.round(channel(h + 1 / 3) * 255), Math.round(channel(h) * 255), Math.round(channel(h - 1 / 3) * 255)];
}

export function rgbToHsl([r, g, b]: Rgb): readonly [number, number, number] {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === red ? (green - blue) / d + (green < blue ? 6 : 0) : max === green ? (blue - red) / d + 2 : (red - green) / d + 4;
  return [(h / 6) * 360, s, l];
}

/** The floor the sidebar's words clear over what they sit on, and the floor an icon clears. */
export const WORD_FLOOR = 4.5;
export const INK_FLOOR = 3;

/** What each side's sidebar is made of, as the theme is read against it: the ground its surface token paints
 * (zinc-50, and the near-black card) and the foreground its words take (zinc-800, and the near-white). The theme
 * lays its colours over the ground at their opacity, and the words have to keep reading on the result. Mirrors of
 * the app's tokens rather than reads of them, because a theme pinned to the side the app is not drawing has no
 * element to read that side's tokens from. */
export const SIDE_INK: Record<"light" | "dark", { readonly ground: Rgb; readonly foreground: Rgb }> = {
  light: { ground: [250, 250, 250], foreground: [39, 39, 42] },
  dark: { ground: [17, 17, 17], foreground: [241, 243, 247] },
};

/** The lightness the ink starts from on each side: dark enough to read on a light surface, light enough on a dark
 * one. The ink keeps some of the dot's own lightness so a pale pick still reads paler than a deep one. */
const INK_LIGHTNESS = { light: 0.38, dark: 0.66 } as const;

const luminance = ([r, g, b]: Rgb): number => {
  const channel = (v: number): number => {
    const u = v / 255;
    return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const over = (top: Rgb, alpha: number, under: Rgb): Rgb => [0, 1, 2].map(i => Math.round(top[i]! * alpha + under[i]! * (1 - alpha))) as unknown as Rgb;

type Side = "light" | "dark";
type Wash = Pick<WorkspaceTheme, "dots" | "opacity">;

/** The least the side's words read at over any of the theme's colours laid on its ground at this alpha. */
function wordsRead(theme: Wash, side: Side, alpha: number): number {
  const { ground, foreground } = SIDE_INK[side];
  return Math.min(...theme.dots.map(dot => contrastRatio(foreground, over(dotColour(dot), alpha, ground))));
}

/** The side a theme draws under, given the app's: its own pin, else the app's side. The opacity cap is what gives
 * when the words would drown, so a dark app stays dark under a pale wash and a light one light under a deep one;
 * only where even the slider's least opacity leaves the app's side unreadable does Auto take the other side, and
 * only while that side reads better there. */
export function themeScheme(theme: Pick<WorkspaceTheme, "mode"> & Partial<Wash>, appDark: boolean): Side {
  if (theme.mode !== "auto") return theme.mode;
  const own: Side = appDark ? "dark" : "light";
  if (theme.dots === undefined || theme.opacity === undefined) return own;
  const other: Side = appDark ? "light" : "dark";
  const wash: Wash = { dots: theme.dots, opacity: theme.opacity };
  const ownReads = wordsRead(wash, own, THEME_MIN_OPACITY);
  return ownReads < WORD_FLOOR && wordsRead(wash, other, THEME_MIN_OPACITY) > ownReads ? other : own;
}

/** How far the opacity may go before the side's words drop under the floor on the colour laid over the ground: the
 * largest step of the slider's grid that keeps them reading, never under the slider's least. The picker's slider
 * ends here, and the paint stops here whatever the record holds. */
export function opacityCap(theme: Pick<WorkspaceTheme, "dots" | "opacity" | "mode">, appDark: boolean): number {
  const side = themeScheme(theme, appDark);
  for (let alpha = 1; alpha > THEME_MIN_OPACITY; alpha = Math.round((alpha - 0.05) * 100) / 100) {
    if (wordsRead(theme, side, alpha) >= WORD_FLOOR) return alpha;
  }
  return THEME_MIN_OPACITY;
}

/** The opacity the theme paints at: the record's, held under the cap. */
export function effectiveOpacity(theme: Pick<WorkspaceTheme, "dots" | "opacity" | "mode">, appDark: boolean): number {
  return Math.min(theme.opacity, opacityCap(theme, appDark));
}

/** The one colour a theme lends the chrome: the first dot, saturated a step and pulled toward the lightness that
 * reads on the side it draws under, then stepped further from the surface until it clears the floor both on the
 * ground and on the first colour laid over it. A pick so deep at full opacity that no lightness of its hue clears
 * both takes the step that clears the ground and comes nearest on the wash. The active space icon and the header's
 * glyph take it; nothing else does. */
export function themeInk(theme: Pick<WorkspaceTheme, "dots" | "mode" | "opacity">, appDark: boolean): Rgb {
  const scheme = themeScheme(theme, appDark);
  const first = dotColour(theme.dots[0]!);
  const [h, s, l] = rgbToHsl(first);
  const { ground } = SIDE_INK[scheme];
  const washed = over(first, effectiveOpacity(theme, appDark), ground);
  const step = scheme === "dark" ? 0.03 : -0.03;
  const at = (lightness: number): Rgb => hslToRgb(h / 360, Math.min(1, s + 0.2), lightness);
  let lightness = l * 0.2 + INK_LIGHTNESS[scheme] * 0.8;
  let best: { ink: Rgb; onWashed: number } | null = null;
  for (let i = 0; i < 24; i++) {
    const ink = at(lightness);
    const onWashed = contrastRatio(ink, washed);
    if (contrastRatio(ink, ground) >= INK_FLOOR) {
      if (onWashed >= INK_FLOOR) return ink;
      if (best === null || onWashed > best.onWashed) best = { ink, onWashed };
    }
    lightness = Math.min(1, Math.max(0, lightness + step));
  }
  return best?.ink ?? at(lightness);
}

/** Preset themes, in the row's order: each is a set of dots with its harmony, and takes the person's grain, opacity
 * and mode as they are. */
export interface ThemePreset {
  readonly id: string;
  readonly dots: ReadonlyArray<ThemeDot>;
  readonly harmony: ThemeHarmony;
}

const preset = (id: string, angle: number, radius: number, harmony: ThemeHarmony): ThemePreset => ({ id, harmony, dots: harmonyDots({ angle, radius }, harmony) });

/** Every dot of every preset, the harmony's included, keeps thirty degrees off the green that means running and the
 * red that means danger: the wash is the owner's exemption for a free pick, the presets are ours. */
export const THEME_PRESETS: ReadonlyArray<ThemePreset> = [
  preset("dusk", 262, 0.62, "analogous"),
  preset("sea", 205, 0.56, "triadic"),
  preset("fern", 95, 0.5, "analogous"),
  preset("clay", 35, 0.6, "complementary"),
  preset("orchid", 320, 0.62, "analogous"),
  preset("sand", 55, 0.72, "single"),
  preset("slate", 225, 0.42, "complementary"),
  preset("plum", 290, 0.46, "complementary"),
];

/** The theme a workspace starts with when a person opens the picker on one that has none. */
export const DEFAULT_THEME: WorkspaceTheme = { ...THEME_PRESETS[0]!, dots: [...THEME_PRESETS[0]!.dots], grain: 0, opacity: 0.5, mode: "auto" };

/** A preset applied over a theme: the dots and harmony move, the rest stays. */
export function applyPreset(theme: WorkspaceTheme, chosen: ThemePreset): WorkspaceTheme {
  return { ...theme, harmony: chosen.harmony, dots: [...chosen.dots] };
}

/** Whether a theme's dots are the preset's, which is what marks the preset as the current one. */
export function isPreset(theme: Pick<WorkspaceTheme, "dots" | "harmony">, chosen: ThemePreset): boolean {
  return theme.harmony === chosen.harmony && theme.dots.length === chosen.dots.length && theme.dots.every((dot, i) => Math.abs(dot.angle - chosen.dots[i]!.angle) < 0.5 && Math.abs(dot.radius - chosen.dots[i]!.radius) < 0.005);
}
