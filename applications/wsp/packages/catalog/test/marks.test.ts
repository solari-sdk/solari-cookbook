// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { agentMark, CATALOG_AGENTS, UNMARKED_AGENTS } from "../src/index.js";

const LICENSES = ["MIT", "CC0-1.0", "Apache-2.0"];
const HEX = /^#[0-9a-f]{6}$/i;
const MARKED = CATALOG_AGENTS.filter(a => !UNMARKED_AGENTS.includes(a.id));

describe("agent marks", () => {
  it("every catalog agent but the named exceptions carries its own mark, with where it came from and under what license", () => {
    expect(CATALOG_AGENTS.filter(a => a.mark === undefined).map(a => a.id)).toEqual([...UNMARKED_AGENTS]);
    for (const a of MARKED) {
      expect(agentMark(a.id), a.id).toBe(a.mark);
      expect(a.mark!.source, a.id).toMatch(/^https:\/\//);
      expect(LICENSES, a.id).toContain(a.mark!.license);
    }
    expect(agentMark("not-an-agent")).toBeUndefined();
  });

  it("a mark is one inline svg of shapes: a viewBox, no text, nothing it loads and nothing it runs", () => {
    for (const a of MARKED) {
      const svg = a.mark!.svg;
      expect(svg, a.id).toMatch(/^<svg\b[^>]*\bviewBox="[\d.]+ [\d.]+ [\d.]+ [\d.]+"[^>]*>[\s\S]*<\/svg>$/);
      expect(svg, a.id).toMatch(/<(path|rect|polygon|circle)\b/);
      expect(svg, a.id).not.toMatch(/<(text|image|script|foreignObject|use|style)\b|\son\w+=|href=/i);
      const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
      for (const ref of svg.matchAll(/url\(([^)]*)\)/g)) expect(ids, `${a.id} ${ref[0]}`).toContain(ref[1]!.replace(/^#/, ""));
    }
  });

  it("inks are a light and a dark hex each; the first fills every shape without a fill, and the svg names the others by index", () => {
    for (const a of MARKED) {
      const inks = a.mark!.inks ?? [];
      for (const ink of inks) expect([ink.light, ink.dark], a.id).toEqual([expect.stringMatching(HEX), expect.stringMatching(HEX)]);
      const named = [...a.mark!.svg.matchAll(/var\(--ink-(\d+)\)/g)].map(m => Number(m[1]));
      for (const at of named) {
        expect(at, a.id).toBeGreaterThan(0);
        expect(at, a.id).toBeLessThan(inks.length);
      }
    }
  });

  it("Pi draws its press kit's three colours", () => {
    const pi = agentMark("pi")!;
    expect(pi.inks).toHaveLength(3);
    expect(pi.inks!.map(i => i.dark)).toEqual(["#f09082", "#4d9abf", "#f1be58"]);
    expect(pi.svg).toContain('fill="var(--ink-1)"');
    expect(pi.svg).toContain('fill="var(--ink-2)"');
  });
});
