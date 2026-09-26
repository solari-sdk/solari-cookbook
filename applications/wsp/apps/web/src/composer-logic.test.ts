// Adapted from pingdotgg/t3code apps/web/src/composer-logic.test.ts at 57a66608 (MIT).
// Differs from upstream: the citation, @path, $skill and cursor-map cases are
// dropped with those arms; a case pins that @path and $skill open no menu here.
import { describe, expect, it } from "vitest";

import {
  clampComposerCursor,
  composerSubmissionIntentForEnter,
  detectComposerTrigger,
  replaceTextRange,
} from "./composer-logic";

describe("composerSubmissionIntentForEnter", () => {
  it("submits plain Enter on desktop", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: false,
        modifierKey: false,
        isDraftThread: true,
      }),
    ).toBe("foreground");
  });

  it("inserts a newline for plain Enter on mobile", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: true,
        shiftKey: false,
        modifierKey: false,
        isDraftThread: true,
      }),
    ).toBeNull();
  });

  it("inserts a newline for Shift+Enter", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: true,
        modifierKey: false,
        isDraftThread: true,
      }),
    ).toBeNull();
  });

  it("submits a new thread in the background with Mod+Enter", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: false,
        modifierKey: true,
        isDraftThread: true,
      }),
    ).toBe("background");
  });

  it("keeps Mod+Enter in the foreground for an active thread", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: false,
        modifierKey: true,
        isDraftThread: false,
      }),
    ).toBe("foreground");
  });
});

describe("detectComposerTrigger", () => {
  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps /model as a slash command item", () => {
    const text = "/model";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "model",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("does not keep a subcommand trigger active after /model arguments", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("detects a slash at the start of a later line with that line's offset", () => {
    const text = "first\n/rev";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: "first\n".length,
      rangeEnd: text.length,
    });
  });

  it("opens no menu for @path or $skill tokens", () => {
    expect(detectComposerTrigger("Please check @src/com", "Please check @src/com".length)).toBeNull();
    expect(detectComposerTrigger("run $unslop", "run $unslop".length)).toBeNull();
  });
});

describe("clampComposerCursor", () => {
  it("bounds the cursor to the text and floors fractions", () => {
    expect(clampComposerCursor("abc", -2)).toBe(0);
    expect(clampComposerCursor("abc", 2.7)).toBe(2);
    expect(clampComposerCursor("abc", 9)).toBe(3);
    expect(clampComposerCursor("abc", Number.NaN)).toBe(3);
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});
