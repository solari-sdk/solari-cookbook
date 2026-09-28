// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { frameSrc, loopbackAddress, loopbackUrl, parseAddress, portAndPath } from "./url.js";

describe("parseAddress", () => {
  it.each([
    ["3000", 3000, "/"],
    [":3000", 3000, "/"],
    ["localhost:3000", 3000, "/"],
    ["http://localhost:3000", 3000, "/"],
    ["http://localhost:3000/", 3000, "/"],
    ["3000/about", 3000, "/about"],
    [":3000/about", 3000, "/about"],
    ["localhost:3000/about?x=1", 3000, "/about?x=1"],
    ["http://localhost:3000/about?x=1", 3000, "/about?x=1"],
    ["https://127.0.0.1:8443/a/b/?x=1&y=2#top", 8443, "/a/b/?x=1&y=2#top"],
    ["  localhost:3000/about  ", 3000, "/about"],
    ["localhost/about", 80, "/about"],
    ["https://localhost", 443, "/"],
    ["3000?x=1", 3000, "/?x=1"],
    ["localhost:3000?x=1", 3000, "/?x=1"],
    ["3000#top", 3000, "/#top"],
    ["localhost:3000/café?name=zoë", 3000, "/caf%C3%A9?name=zo%C3%AB"],
  ])("%s means port %d at %s", (raw, port, path) => {
    expect(parseAddress(raw)).toEqual({ port, path });
  });

  it.each(["example.com:3000/about", "ftp://localhost:21/x", "70000", ":0", "about", "3000about", ""])("%s is not an address this pane frames", raw => {
    expect(parseAddress(raw)).toBeNull();
  });
});

describe("frameSrc", () => {
  const ROUTE = "https://m1-3000.preview.example/?pt_token=edge";

  it("leaves the minted route alone at the root", () => {
    expect(frameSrc(ROUTE, "/")).toBe(ROUTE);
  });

  it("puts the path before the query and keeps the token beside the page's own parameters", () => {
    expect(frameSrc(ROUTE, "/about?x=1")).toBe("https://m1-3000.preview.example/about?pt_token=edge&x=1");
  });

  it("carries a fragment after the query", () => {
    expect(frameSrc(ROUTE, "/docs#install")).toBe("https://m1-3000.preview.example/docs?pt_token=edge#install");
  });

  it("drops a pt_token typed into the page's query: the edge's is the only one", () => {
    expect(frameSrc(ROUTE, "/about?pt_token=evil&x=1")).toBe("https://m1-3000.preview.example/about?pt_token=edge&x=1");
    expect(frameSrc(ROUTE, "/about?x=1&pt_token=evil")).toBe("https://m1-3000.preview.example/about?pt_token=edge&x=1");
    expect(frameSrc(ROUTE, "/about?pt_token=evil")).toBe("https://m1-3000.preview.example/about?pt_token=edge");
  });

  it("keeps the path and the query in their encoded form", () => {
    expect(frameSrc(ROUTE, "/a%20b/c?q=hello%20world")).toBe("https://m1-3000.preview.example/a%20b/c?pt_token=edge&q=hello%20world");
    expect(frameSrc(ROUTE, "/caf%C3%A9?name=zo%C3%AB")).toBe("https://m1-3000.preview.example/caf%C3%A9?pt_token=edge&name=zo%C3%AB");
  });

  it("takes the edge's own form of the route, with no slash before the token", () => {
    expect(frameSrc("https://abc-8000.preview.getsolari.com?pt_token=t", "/sub/index.html")).toBe("https://abc-8000.preview.getsolari.com/sub/index.html?pt_token=t");
  });
});

describe("loopback forms", () => {
  it("the url keys recents and the bare form is what the bar shows, both without a slash at the root", () => {
    expect(loopbackUrl(3000)).toBe("http://localhost:3000");
    expect(loopbackUrl(3000, "/about?x=1")).toBe("http://localhost:3000/about?x=1");
    expect(loopbackAddress(3000, "/")).toBe("localhost:3000");
    expect(loopbackAddress(3000, "/about?x=1")).toBe("localhost:3000/about?x=1");
  });

  it("what a person reads is decoded, what a browser dials stays encoded, and a malformed escape is shown as typed", () => {
    expect(loopbackUrl(3000, "/caf%C3%A9?name=zo%C3%AB")).toBe("http://localhost:3000/caf%C3%A9?name=zo%C3%AB");
    expect(loopbackAddress(3000, "/caf%C3%A9?name=zo%C3%AB")).toBe("localhost:3000/café?name=zoë");
    expect(portAndPath(3000, "/caf%C3%A9")).toBe(":3000/café");
    expect(loopbackAddress(3000, "/a%2Fb%3Fc")).toBe("localhost:3000/a%2Fb%3Fc");
    expect(loopbackAddress(3000, "/%E0%A4%A")).toBe("localhost:3000/%E0%A4%A");
  });
});
