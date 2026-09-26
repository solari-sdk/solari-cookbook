// SPDX-License-Identifier: AGPL-3.0-only
// The theme's maths: a dot's colour from where it sits on the wheel, the dots
// a harmony places around the first, the count moving up and down, the ink
// the chrome takes on each side, the presets, and the custom properties the
// sidebar paints with.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  THEME_GRAIN_STEPS,
  THEME_HARMONIES,
  THEME_MAX_DOTS,
  THEME_PRESETS,
  INK_FLOOR,
  SIDE_INK,
  WORD_FLOOR,
  applyPreset,
  contrastRatio,
  effectiveOpacity,
  fmtPercent,
  fmtRgb,
  opacityCap,
  cycleHarmony,
  dotColour,
  fmtThemeVars,
  harmoniesOf,
  harmonyDots,
  harmonySize,
  isPreset,
  moveFirstDot,
  resizeDots,
  rgbToHsl,
  snapGrain,
  themeInk,
  themeScheme,
  type WorkspaceTheme,
} from "../src/index.js";

const theme: WorkspaceTheme = { ...DEFAULT_THEME, dots: harmonyDots({ angle: 200, radius: 0.5 }, "complementary"), harmony: "complementary" };

describe("a dot's colour", () => {
  it("takes its hue from the angle and its lightness from the distance: black at the centre, white at the rim, the hue whole halfway", () => {
    expect(dotColour({ angle: 0, radius: 0 })).toEqual([0, 0, 0]);
    expect(dotColour({ angle: 120, radius: 1 })).toEqual([255, 255, 255]);
    const [h, s, l] = rgbToHsl(dotColour({ angle: 200, radius: 0.5 }));
    expect(Math.round(h)).toBe(200);
    expect(s).toBeCloseTo(0.95, 1);
    expect(l).toBeCloseTo(0.5, 1);
    expect(dotColour({ angle: 0, radius: 0.5 })).toEqual([249, 6, 6]);
  });
});

describe("the harmonies", () => {
  it("place one, two or three dots at the first one's radius, at fixed angles from it, wrapping the wheel", () => {
    expect(THEME_HARMONIES.map(harmonySize)).toEqual([1, 2, 2, 3, 3, 3]);
    expect(harmoniesOf(2)).toEqual(["complementary", "analogous"]);
    expect(harmoniesOf(4)).toEqual([]);
    expect(harmonyDots({ angle: 350, radius: 0.4 }, "complementary")).toEqual([{ angle: 350, radius: 0.4 }, { angle: 170, radius: 0.4 }]);
    expect(harmonyDots({ angle: 300, radius: 0.4 }, "triadic")).toEqual([{ angle: 300, radius: 0.4 }, { angle: 60, radius: 0.4 }, { angle: 180, radius: 0.4 }]);
  });

  it("moving the first dot carries the others with it; adding and removing a dot picks the first harmony of the new size, and the count stops at both ends", () => {
    const moved = moveFirstDot(theme, { angle: 10, radius: 0.8 });
    expect(moved.dots).toEqual([{ angle: 10, radius: 0.8 }, { angle: 190, radius: 0.8 }]);
    expect(moved.harmony).toBe("complementary");
    const three = resizeDots(theme, 1)!;
    expect(three.harmony).toBe("splitComplementary");
    expect(three.dots).toHaveLength(3);
    expect(resizeDots(three, 1)).toBeNull();
    expect(three.dots).toHaveLength(THEME_MAX_DOTS);
    const one = resizeDots(theme, -1)!;
    expect(one).toMatchObject({ harmony: "single", dots: [{ angle: 200, radius: 0.5 }] });
    expect(resizeDots(one, -1)).toBeNull();
  });

  it("cycling walks the harmonies of the same size and wraps, re-placing the dots each time", () => {
    const next = cycleHarmony(theme);
    expect(next.harmony).toBe("analogous");
    expect(next.dots[1]).toEqual({ angle: 150, radius: 0.5 });
    expect(cycleHarmony(next).harmony).toBe("complementary");
    const one = resizeDots(theme, -1)!;
    expect(cycleHarmony(one)).toEqual(one);
  });
});

describe("grain, scheme and ink", () => {
  it("the grain snaps to the slider's steps inside 0 and 1", () => {
    expect(snapGrain(0.49)).toBe(Math.round(0.49 * THEME_GRAIN_STEPS) / THEME_GRAIN_STEPS);
    expect(snapGrain(-1)).toBe(0);
    expect(snapGrain(7)).toBe(1);
  });

  it("auto keeps the app's side and lets the opacity cap give, so a dark app stays dark under a pale wash; a pinned side stays whatever the app draws", () => {
    expect(themeScheme(theme, true)).toBe("dark");
    expect(themeScheme(theme, false)).toBe("light");
    // A pale colour laid whole on a dark app: the side stays dark and the cap drops instead of the words.
    const pale: WorkspaceTheme = { ...theme, dots: [{ angle: 55, radius: 0.72 }], harmony: "single", opacity: 1 };
    expect(themeScheme(pale, true)).toBe("dark");
    expect(opacityCap(pale, true)).toBeLessThan(0.5);
    expect(themeScheme(pale, false)).toBe("light");
    // A deep colour laid whole on a light app: the same the other way round.
    const deep: WorkspaceTheme = { ...theme, dots: [{ angle: 262, radius: 0.22 }], harmony: "single", opacity: 1 };
    expect(themeScheme(deep, false)).toBe("light");
    expect(opacityCap(deep, false)).toBeLessThan(0.5);
    expect(themeScheme(deep, true)).toBe("dark");
    // Every preset at the default opacity draws under the app's own side on both sides.
    for (const preset of THEME_PRESETS) {
      const picked = { ...theme, dots: [...preset.dots] };
      expect({ id: preset.id, dark: themeScheme(picked, true), light: themeScheme(picked, false) }).toEqual({ id: preset.id, dark: "dark", light: "light" });
    }
    expect(themeScheme({ ...pale, mode: "dark" }, false)).toBe("dark");
    expect(themeScheme({ ...deep, mode: "light" }, true)).toBe("light");
  });

  it("the opacity stops where the side's own words would drop under AA on the colour laid over the ground, and the formatter paints at that stop", () => {
    const side = (dark: boolean) => SIDE_INK[dark ? "dark" : "light"];
    const over = (top: readonly number[], alpha: number, under: readonly number[]) => [0, 1, 2].map(i => Math.round(top[i]! * alpha + under[i]! * (1 - alpha))) as unknown as readonly [number, number, number];
    // Moss green pinned dark on a light app, the state that read as light ink on saturated green: the dark side's
    // foreground would fall to 2.4 to 1 at 100%, so the paint stops short of it.
    const pinnedDark: WorkspaceTheme = { ...theme, dots: [{ angle: 150, radius: 0.52 }], harmony: "single", opacity: 1, mode: "dark" };
    const cap = opacityCap(pinnedDark, false);
    expect(cap).toBeLessThan(1);
    expect(cap).toBeGreaterThanOrEqual(0.1);
    expect(effectiveOpacity(pinnedDark, false)).toBe(cap);
    expect(contrastRatio(side(true).foreground, over(dotColour(pinnedDark.dots[0]!), cap, side(true).ground))).toBeGreaterThanOrEqual(WORD_FLOOR);
    expect(contrastRatio(side(true).foreground, over(dotColour(pinnedDark.dots[0]!), cap + 0.05, side(true).ground))).toBeLessThan(WORD_FLOOR);
    expect(fmtThemeVars(pinnedDark, false)["--space-gradient"]).toContain(`/ ${Math.round(cap * 100)}%)`);
    // A quiet wash at the default opacity is never touched.
    expect(effectiveOpacity(theme, false)).toBe(theme.opacity);
    expect(effectiveOpacity(theme, true)).toBe(theme.opacity);
    // Every preset keeps most of its colour on both sides; the ones whose wash crowds the dark words at the default
    // 50 percent (sea, fern, sand on a dark app) paint a step under it rather than moving the side.
    for (const preset of THEME_PRESETS) {
      for (const appDark of [false, true]) expect({ id: preset.id, appDark, cap: opacityCap({ ...theme, dots: [...preset.dots] }, appDark) >= 0.4 }).toEqual({ id: preset.id, appDark, cap: true });
    }
    // Every dot counts, not the first alone: a pale second colour pulls the cap under what the first alone allows.
    const twoTone: WorkspaceTheme = { ...theme, dots: [{ angle: 225, radius: 0.42 }, { angle: 55, radius: 0.72 }], harmony: "complementary", opacity: 1 };
    expect(opacityCap(twoTone, true)).toBeLessThan(opacityCap({ ...twoTone, dots: [twoTone.dots[0]!] }, true));
  });

  it("the ink keeps the first dot's hue and lands darker on the light side than on the dark, whatever the pick's own lightness", () => {
    for (const radius of [0.15, 0.5, 0.9]) {
      // The sides are pinned here: Auto would move a pale or deep pick to the side whose words read on it.
      const pick = { ...theme, dots: harmonyDots({ angle: 200, radius }, "complementary") };
      const [lightH, , lightL] = rgbToHsl(themeInk({ ...pick, mode: "light" }, false));
      const [darkH, , darkL] = rgbToHsl(themeInk({ ...pick, mode: "dark" }, true));
      expect(Math.round(lightH)).toBe(200);
      expect(Math.round(darkH)).toBe(200);
      expect(lightL).toBeLessThan(0.5);
      expect(darkL).toBeGreaterThan(0.55);
      expect(darkL).toBeGreaterThan(lightL);
    }
    // A pinned side takes that side's ink even when the app draws the other.
    expect(themeInk({ ...theme, mode: "dark" }, false)).toEqual(themeInk(theme, true));
  });

  it("the ink clears the graphics floor on the ground always, and on the first colour laid over it for every preset and every pick at the default opacity", () => {
    const ground = { light: [250, 250, 250] as const, dark: [17, 17, 17] as const };
    const over = (top: readonly number[], alpha: number, under: readonly number[]) => [0, 1, 2].map(i => Math.round(top[i]! * alpha + under[i]! * (1 - alpha))) as unknown as readonly [number, number, number];
    const sweep = [0.1, 0.3, 0.5, 0.7, 0.9].flatMap(radius => [0, 60, 120, 180, 240, 300].map(angle => ({ angle, radius })));
    const picks = [
      ...THEME_PRESETS.map(preset => ({ dots: [...preset.dots], opacity: 0.5, both: true })),
      ...sweep.map(dot => ({ dots: [dot], opacity: 0.5, both: true })),
      // At full opacity a near-black pick on the light side leaves no lightness of its hue that reads on both.
      ...sweep.map(dot => ({ dots: [dot], opacity: 1, both: false })),
    ];
    for (const appDark of [false, true]) {
      for (const { both, ...pick } of picks) {
        const chosen = { ...pick, mode: "auto" as const };
        const ink = themeInk(chosen, appDark);
        // The ground is the side the theme draws under, which Auto may move off the app's, at the opacity it paints at.
        const under = ground[themeScheme(chosen, appDark)];
        const washed = over(dotColour(pick.dots[0]!), effectiveOpacity(chosen, appDark), under);
        expect({ pick, appDark, onGround: contrastRatio(ink, under) >= INK_FLOOR, onWashed: both ? contrastRatio(ink, washed) >= INK_FLOOR : true }).toEqual({ pick, appDark, onGround: true, onWashed: true });
      }
    }
  });
});

describe("the presets", () => {
  it("keep every dot thirty degrees off the green that means running and the red that means danger", () => {
    const apart = (a: number, b: number): number => {
      const d = Math.abs(a - b) % 360;
      return Math.min(d, 360 - d);
    };
    for (const preset of THEME_PRESETS) {
      for (const dot of preset.dots) {
        expect({ id: preset.id, angle: dot.angle, offGreen: apart(dot.angle, 160) >= 30, offRed: apart(dot.angle, 0) >= 30 }).toEqual({ id: preset.id, angle: dot.angle, offGreen: true, offRed: true });
      }
    }
  });

  it("are distinct, each a harmony with its dots placed, and applying one moves the dots alone", () => {
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(THEME_PRESETS.map(p => p.id)).size).toBe(THEME_PRESETS.length);
    for (const chosen of THEME_PRESETS) {
      expect(chosen.dots).toEqual(harmonyDots(chosen.dots[0]!, chosen.harmony));
      expect(chosen.dots.length).toBeLessThanOrEqual(THEME_MAX_DOTS);
    }
    const custom = { ...theme, grain: 0.5, opacity: 0.3, mode: "dark" as const };
    const applied = applyPreset(custom, THEME_PRESETS[2]!);
    expect(applied).toMatchObject({ grain: 0.5, opacity: 0.3, mode: "dark", harmony: THEME_PRESETS[2]!.harmony });
    expect(isPreset(applied, THEME_PRESETS[2]!)).toBe(true);
    expect(isPreset(applied, THEME_PRESETS[0]!)).toBe(false);
    expect(isPreset(moveFirstDot(applied, { angle: 5, radius: 0.5 }), THEME_PRESETS[2]!)).toBe(false);
    expect(isPreset(DEFAULT_THEME, THEME_PRESETS[0]!)).toBe(true);
  });
});

describe("the custom properties", () => {
  it("one dot lays its colour flat, two fade from opposite corners, three settle in two corners over a third rising, every stop at the opacity", () => {
    const one = fmtThemeVars({ ...theme, dots: [{ angle: 0, radius: 0.5 }], harmony: "single", opacity: 0.5 }, false);
    expect(one["--space-gradient"]).toBe("linear-gradient(rgb(249 6 6 / 50%), rgb(249 6 6 / 50%))");
    const two = fmtThemeVars({ ...theme, opacity: 0.7 }, false)["--space-gradient"];
    expect(two.match(/gradient\(/g)).toHaveLength(2);
    expect(two.match(/ \/ 70%\)/g)).toHaveLength(2);
    expect(two).toContain("transparent");
    const three = fmtThemeVars(resizeDots(theme, 1)!, false)["--space-gradient"];
    expect(three.match(/radial-gradient\(/g)).toHaveLength(2);
    expect(three.match(/linear-gradient\(/g)).toHaveLength(1);
  });

  it("the percent and the rgb strings have one home, and the stops and the ink are written with them", () => {
    expect(fmtPercent(0.5)).toBe("50%");
    expect(fmtPercent(0.333)).toBe("33%");
    expect(fmtRgb([1, 2, 3])).toBe("rgb(1 2 3)");
    expect(fmtRgb([1, 2, 3], 0.25)).toBe("rgb(1 2 3 / 25%)");
    const vars = fmtThemeVars({ ...theme, dots: [{ angle: 0, radius: 0.5 }], harmony: "single" }, false);
    expect(vars["--space-gradient"]).toContain(fmtRgb(dotColour({ angle: 0, radius: 0.5 }), theme.opacity));
    expect(vars["--space-tint"]).toBe(fmtRgb(themeInk({ ...theme, dots: [{ angle: 0, radius: 0.5 }] }, false)));
  });

  it("carry the grain as the slider's number and the ink for the side the theme draws under", () => {
    const vars = fmtThemeVars({ ...theme, grain: 0.25 }, true);
    expect(vars["--space-grain"]).toBe("0.25");
    const ink = themeInk(theme, true);
    expect(vars["--space-tint"]).toBe(`rgb(${ink[0]} ${ink[1]} ${ink[2]})`);
    expect(Object.keys(vars)).toEqual(["--space-gradient", "--space-grain", "--space-tint"]);
  });
});
