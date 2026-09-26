// Adapted from pingdotgg/t3code apps/web/src/filePathDisplay.test.ts at 57a66608 (MIT).
// Differs from upstream: fixture paths use "workspace" where upstream used its own repo name.
import { describe, expect, it } from "vitest";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("formats absolute workspace paths from the workspace root", () => {
    expect(
      formatWorkspaceRelativePath(
        "C:/Users/mike/dev-stuff/workspace/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/workspace",
      ),
    ).toBe("workspace/apps/web/src/session-logic.ts:501");
  });

  it("prefixes relative paths with the workspace root label", () => {
    expect(
      formatWorkspaceRelativePath(
        "apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/workspace",
      ),
    ).toBe("workspace/apps/web/src/session-logic.ts:501");
  });

  it("keeps paths already rooted at the workspace label stable", () => {
    expect(
      formatWorkspaceRelativePath(
        "workspace/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/workspace",
      ),
    ).toBe("workspace/apps/web/src/session-logic.ts:501");
  });

  it("preserves columns when present", () => {
    expect(
      formatWorkspaceRelativePath(
        "/C:/Users/mike/dev-stuff/workspace/apps/web/src/session-logic.ts:501:9",
        "C:/Users/mike/dev-stuff/workspace",
      ),
    ).toBe("workspace/apps/web/src/session-logic.ts:501:9");
  });
});
