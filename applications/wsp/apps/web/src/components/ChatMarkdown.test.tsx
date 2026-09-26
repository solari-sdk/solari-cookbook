// Adapted from pingdotgg/t3code apps/web/src/components/ChatMarkdown.test.tsx at 57a66608 (MIT).
// Differs from upstream: only the three orderedListGutterStyle cases are upstream's; the rest of the file is wsp's own, under the license below.
// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import ChatMarkdown, { orderedListGutterStyle } from "./ChatMarkdown";
import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

describe("ChatMarkdown", () => {
  it("renders emphasis through the markdown pipeline", () => {
    const { container } = render(
      <ChatMarkdown text="Some **bold** text" cwd="/tmp/project" resolvedTheme="dark" />,
    );

    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe("bold");
  });

  it("highlights a fenced code block once the highlighter resolves", async () => {
    // The highlighter resolves outside React's act scope; settle it inside one
    // so the Suspense retry commits before asserting.
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <ChatMarkdown
          text={"```ts\nconst answer: number = 42;\n```"}
          cwd="/tmp/project"
          resolvedTheme="dark"
        />,
      ));
    });
    expect(container.querySelector(".chat-markdown-codeblock")).not.toBeNull();
    await act(async () => {
      await getSyntaxHighlighterPromise("ts");
    });
    await waitFor(
      () => {
        const shiki = container.querySelector(".chat-markdown-shiki");
        expect(shiki).not.toBeNull();
        expect(shiki?.innerHTML).toContain('<span style="color:');
      },
      { timeout: 20_000 },
    );
  }, 30_000);

  it.each(["light", "dark"] as const)("draws a one-line fenced block's line in the %s theme, in ink the block is not", async theme => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <ChatMarkdown text={"hello.txt says:\n\n```text\nbanana\n```"} cwd="/tmp/project" resolvedTheme={theme} />,
      ));
    });
    await act(async () => {
      await getSyntaxHighlighterPromise("text");
    });
    await waitFor(() => expect(container.querySelector(".chat-markdown-shiki .line")).not.toBeNull(), { timeout: 20_000 });

    // The line is drawn, and it is drawn for the side the block is being shown on: a block highlighted for the
    // other side draws its one line in the ink the box's own ground is, which reads as an empty box.
    const pre = container.querySelector<HTMLElement>(".chat-markdown-shiki .shiki")!;
    expect(container.querySelector(".chat-markdown-shiki .line")?.textContent).toBe("banana");
    expect(pre.className).toContain(theme === "dark" ? "pierre-dark" : "pierre-light");
    expect(pre.style.color).not.toBe("");
    expect(pre.style.color).not.toBe(pre.style.backgroundColor);
  }, 30_000);

  it("colours a cold line fully even when the tokenizer runs slowly", async () => {
    await act(async () => {
      await getSyntaxHighlighterPromise("tsx");
    });
    // vscode-textmate reads Date.now to cut a line at shiki's 500 ms limit; a clock that jumps a second per read is a starved main thread.
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    try {
      let container!: HTMLElement;
      await act(async () => {
        ({ container } = render(
          <ChatMarkdown
            text={'```tsx\nconst el = <div className="x">{count}</div>;\n```'}
            cwd="/tmp/project"
            resolvedTheme="dark"
          />,
        ));
      });
      await waitFor(
        () => expect(container.querySelector(".chat-markdown-shiki")).not.toBeNull(),
        { timeout: 20_000 },
      );
      const line = container.querySelector(".chat-markdown-shiki .line");
      expect(line?.textContent).toBe('const el = <div className="x">{count}</div>;');
      expect(line?.querySelectorAll("span[style]").length).toBeGreaterThan(3);
    } finally {
      clock.mockRestore();
    }
  }, 30_000);

  it("opens external links in a new tab", () => {
    const { container } = render(
      <ChatMarkdown text="See [link](https://example.com)" cwd="/tmp/project" resolvedTheme="light" />,
    );

    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.textContent).toBe("link");
  });

  it("scrolls to a heading a reply links to and leaves the page's address alone", () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    window.history.replaceState(null, "", "/#w/ws_a/t/thr_1");
    const { container } = render(
      <ChatMarkdown text={'<h2 id="the-plan">The plan</h2>\n\n[jump](#the-plan)'} cwd="/tmp/project" resolvedTheme="light" />,
    );

    const anchor = container.querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe("#the-plan");
    fireEvent.click(anchor);
    expect(scrolled).toHaveBeenCalled();
    // The address names the thread the person is reading; a fragment written over it would cost them that on a reload.
    expect(window.location.hash).toBe("#w/ws_a/t/thr_1");
    scrolled.mockRestore();
  });

  it("reports task list toggles with the marker offset", () => {
    const onTaskListChange = vi.fn();
    render(
      <ChatMarkdown
        text={"- [ ] first\n- [x] second"}
        cwd="/tmp/project"
        resolvedTheme="light"
        onTaskListChange={onTaskListChange}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]!);
    expect(onTaskListChange).toHaveBeenCalledWith({ markerOffset: 2, checked: true });
    fireEvent.click(checkboxes[1]!);
    expect(onTaskListChange).toHaveBeenCalledWith({ markerOffset: 14, checked: false });
  });

  it("turns single newlines into hard breaks when lineBreaks is set", () => {
    const { container: withBreaks } = render(
      <ChatMarkdown text={"line one\nline two"} cwd="/tmp/project" resolvedTheme="light" lineBreaks />,
    );
    const { container: withoutBreaks } = render(
      <ChatMarkdown text={"line one\nline two"} cwd="/tmp/project" resolvedTheme="light" />,
    );

    expect(withBreaks.querySelector("br")).not.toBeNull();
    expect(withoutBreaks.querySelector("br")).toBeNull();
  });

  it("renders a file link as a button that opens the file when a handler is given", () => {
    const onOpenFile = vi.fn();
    render(
      <ChatMarkdown
        text="[Source](/tmp/project/src/main.ts#L12)"
        cwd="/tmp/project"
        resolvedTheme="light"
        onOpenFile={onOpenFile}
      />,
    );

    const chip = screen.getByRole("button", { name: /main\.ts/ });
    fireEvent.click(chip);
    expect(onOpenFile).toHaveBeenCalledWith("src/main.ts", 12);
  });

  it("renders a file link as an inert chip without a handler", () => {
    const { container } = render(
      <ChatMarkdown
        text="[Source](/tmp/project/src/main.ts)"
        cwd="/tmp/project"
        resolvedTheme="light"
      />,
    );

    const chip = container.querySelector(".chat-markdown-file-link");
    expect(chip?.tagName).toBe("SPAN");
    expect(chip?.textContent).toContain("main.ts");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("widens the gutter for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toEqual({ "--list-gutter": "3ch" });
  });

  it("uses the widest marker and includes a negative start's minus sign", () => {
    expect(orderedListGutterStyle(1001, -1000)).toEqual({ "--list-gutter": "6ch" });
    expect(orderedListGutterStyle(3, -15)).toEqual({ "--list-gutter": "4ch" });
  });
});
