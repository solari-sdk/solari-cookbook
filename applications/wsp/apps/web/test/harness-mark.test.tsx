// SPDX-License-Identifier: AGPL-3.0-only
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CATALOG_AGENTS, UNMARKED_AGENTS } from "@wsp/catalog";
import { HarnessMark, harnessInitials } from "../src/components/chat/HarnessMark.js";

describe("HarnessMark", () => {
  it("every catalog agent but the named exception draws its own mark as an svg, never its initials", () => {
    for (const a of CATALOG_AGENTS.filter(e => !UNMARKED_AGENTS.includes(e.id))) {
      const { container, unmount } = render(<HarnessMark harness={a.id} label={a.name} />);
      const svg = container.querySelector(`svg[data-harness-mark="${a.id}"]`);
      expect(svg, a.id).not.toBeNull();
      expect(svg!.getAttribute("viewBox"), a.id).toBe(/viewBox="([^"]+)"/.exec(a.mark!.svg)![1]);
      expect(svg!.querySelector("path, rect, polygon, circle"), a.id).not.toBeNull();
      expect(svg!.hasAttribute("data-initials"), a.id).toBe(false);
      expect(container.textContent, a.id).toBe("");
      unmount();
    }
  });

  it("a mark with inks wears each per theme, the first as its colour; one without takes the colour of whatever it sits in", () => {
    const { container } = render(
      <>
        <HarnessMark harness="claude" label="Claude Code" />
        <HarnessMark harness="codex" label="Codex" />
      </>,
    );
    const claude = container.querySelector<SVGElement>('[data-harness-mark="claude"]')!;
    const [ink] = CATALOG_AGENTS.find(a => a.id === "claude")!.mark!.inks!;
    expect([claude.style.getPropertyValue("--ink-0-light"), claude.style.getPropertyValue("--ink-0-dark")]).toEqual([ink!.light, ink!.dark]);
    expect(claude.getAttribute("class")).toContain("text-(--ink-0)");
    expect(claude.getAttribute("class")).toContain("dark:[--ink-0:var(--ink-0-dark)]");
    const codex = container.querySelector<SVGElement>('[data-harness-mark="codex"]')!;
    expect([...codex.classList].filter(k => k.startsWith("text-") || k.startsWith("dark:"))).toEqual([]);
    expect(codex.getAttribute("style")).toBeNull();
  });

  it("two marks of one agent on a page keep their gradients apart, each fill pointing into its own svg", () => {
    const { container } = render(
      <>
        <HarnessMark harness="gemini" label="Gemini CLI" />
        <HarnessMark harness="gemini" label="Gemini CLI" />
      </>,
    );
    const svgs = [...container.querySelectorAll("svg")];
    const ids = svgs.map(s => [...s.querySelectorAll("[id]")].map(e => e.id));
    expect(ids[0]!.length).toBeGreaterThan(0);
    expect(ids[0]!.filter(id => ids[1]!.includes(id))).toEqual([]);
    svgs.forEach((svg, at) => {
      for (const el of svg.querySelectorAll("[fill^='url(']")) expect(ids[at]).toContain(/url\(#([^)]+)\)/.exec(el.getAttribute("fill")!)![1]);
    });
  });

  it("Pi's three shapes take three inks, each switched per theme", () => {
    const { container } = render(<HarnessMark harness="pi" label="Pi" />);
    const pi = container.querySelector<SVGElement>('[data-harness-mark="pi"]')!;
    const inks = CATALOG_AGENTS.find(a => a.id === "pi")!.mark!.inks!;
    inks.forEach((ink, at) => {
      expect([pi.style.getPropertyValue(`--ink-${at}-light`), pi.style.getPropertyValue(`--ink-${at}-dark`)]).toEqual([ink.light, ink.dark]);
      expect(pi.getAttribute("class")).toContain(`dark:[--ink-${at}:var(--ink-${at}-dark)]`);
    });
    expect([...pi.querySelectorAll("path")].map(p => p.getAttribute("fill"))).toEqual([null, "var(--ink-1)", "var(--ink-2)"]);
  });

  it("an agent with no mark draws its initials in the box a mark takes, so they scale with it", () => {
    for (const id of UNMARKED_AGENTS) {
      const { container, unmount } = render(<HarnessMark harness={id} label={CATALOG_AGENTS.find(a => a.id === id)!.name} className="size-5" />);
      const initials = container.querySelector(`svg[data-harness-mark="${id}"][data-initials]`)!;
      expect(initials.getAttribute("viewBox")).toBe("0 0 20 20");
      expect(initials.getAttribute("class")).toContain("size-5");
      expect(initials.querySelector("text")!.textContent).toBe(harnessInitials(CATALOG_AGENTS.find(a => a.id === id)!.name));
      expect(Number(initials.querySelector("text")!.getAttribute("font-size"))).toBeGreaterThanOrEqual(10);
      unmount();
    }
  });

  it("a harness the catalog does not know falls back to its initials in the surrounding colour", () => {
    const { container } = render(<HarnessMark harness="someone" label="Someone Else" />);
    const fallback = container.querySelector('[data-harness-mark="someone"][data-initials]')!;
    expect(fallback.textContent).toBe("SE");
    expect(fallback.getAttribute("class")).not.toMatch(/text-/);
  });

  it("initials: two letters of one word, first letters of two", () => {
    expect(harnessInitials("Codex")).toBe("CO");
    expect(harnessInitials("Gemini CLI")).toBe("GC");
    expect(harnessInitials("")).toBe("");
  });
});
