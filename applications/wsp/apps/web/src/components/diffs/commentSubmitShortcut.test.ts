// Adapted from pingdotgg/t3code apps/web/src/components/diffs/commentSubmitShortcut.test.ts at 57a66608 (MIT).
import { describe, expect, it } from "vitest";

import { isCommentSubmitShortcut } from "./commentSubmitShortcut";

describe("isCommentSubmitShortcut", () => {
  it("accepts Command or Ctrl+Enter only while an eligible comment is idle", () => {
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false }, "Looks good", false),
    ).toBe(true);
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: true }, "Looks good", false),
    ).toBe(true);
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false }, "Looks good", true),
    ).toBe(false);
  });

  it("rejects empty comments and unrelated key presses", () => {
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false }, "   ", false),
    ).toBe(false);
    expect(
      isCommentSubmitShortcut({ key: "K", metaKey: true, ctrlKey: false }, "Looks good", false),
    ).toBe(false);
  });
});
