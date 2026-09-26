// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { pagePreviews, type PageImage } from "../src/previews.js";

/** A NativeImage the width of whatever it was last resized to; the url says which page and which width. */
function fakeImage(page: string, width = 0): PageImage {
  return {
    resize: options => fakeImage(page, options.width),
    toDataURL: () => `data:image/png;base64,${page}@${width}`,
  };
}

const fakePage = (name: string) => ({ capturePage: vi.fn(async () => fakeImage(name)) });

describe("pagePreviews", () => {
  it("holds one downscaled picture per workspace, and the newest capture replaces it", async () => {
    const previews = pagePreviews(480, 12);
    expect(previews.get("ws_a")).toBeUndefined();
    await previews.capture("ws_a", fakePage("first"));
    expect(previews.get("ws_a")).toBe("data:image/png;base64,first@480");
    await previews.capture("ws_a", fakePage("second"));
    expect(previews.get("ws_a")).toBe("data:image/png;base64,second@480");
    await previews.capture("ws_b", fakePage("other"));
    expect(previews.get("ws_b")).toBe("data:image/png;base64,other@480");
    expect(previews.get("ws_a")).toBe("data:image/png;base64,second@480");
  });

  it("drops the workspace photographed longest ago once the cap is reached, so a long run cannot grow without end", async () => {
    const previews = pagePreviews(240, 2);
    await previews.capture("ws_a", fakePage("a"));
    await previews.capture("ws_b", fakePage("b"));
    await previews.capture("ws_c", fakePage("c"));
    expect(previews.get("ws_a")).toBeUndefined();
    expect(previews.get("ws_b")).toBe("data:image/png;base64,b@240");
    expect(previews.get("ws_c")).toBe("data:image/png;base64,c@240");
  });

  it("counts a workspace photographed again as the newest, not as the oldest it once was", async () => {
    const previews = pagePreviews(240, 2);
    await previews.capture("ws_a", fakePage("a"));
    await previews.capture("ws_b", fakePage("b"));
    await previews.capture("ws_a", fakePage("a2"));
    await previews.capture("ws_c", fakePage("c"));
    expect(previews.get("ws_b")).toBeUndefined();
    expect(previews.get("ws_a")).toBe("data:image/png;base64,a2@240");
  });
});
