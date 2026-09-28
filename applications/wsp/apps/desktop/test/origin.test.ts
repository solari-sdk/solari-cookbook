// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { allowed, fromAppPage, fromOnboardingPage, hostsViewFor, notForThisPage } from "../src/origin.js";

describe("fromAppPage", () => {
  const app = "http://127.0.0.1:4400";

  it("accepts a frame on the host's origin, whatever its path", () => {
    expect(fromAppPage("http://127.0.0.1:4400/", app)).toBe(true);
    expect(fromAppPage("http://127.0.0.1:4400/workspaces/w1?tab=terminal#x", app)).toBe(true);
  });

  it("refuses every other origin, the setup page, a missing frame and an unparsable url", () => {
    expect(fromAppPage("http://127.0.0.1:4401/", app)).toBe(false);
    expect(fromAppPage("http://localhost:4400/", app)).toBe(false);
    expect(fromAppPage("https://127.0.0.1:4400/", app)).toBe(false);
    expect(fromAppPage("http://127.0.0.1:4400.evil.example/", app)).toBe(false);
    expect(fromAppPage("http://evil.example/http://127.0.0.1:4400/", app)).toBe(false);
    expect(fromAppPage("file:///Users/me/wsp/onboarding.html", app)).toBe(false);
    expect(fromAppPage("about:blank", app)).toBe(false);
    expect(fromAppPage(undefined, app)).toBe(false);
    expect(fromAppPage("not a url", app)).toBe(false);
  });
});

describe("fromOnboardingPage", () => {
  const page = "/Applications/wsp.app/Contents/Resources/app/main/onboarding.html";

  it("accepts the onboarding page's own file url, whatever query rides on it", () => {
    expect(fromOnboardingPage("file:///Applications/wsp.app/Contents/Resources/app/main/onboarding.html", page)).toBe(true);
    expect(fromOnboardingPage("file:///Applications/wsp.app/Contents/Resources/app/main/onboarding.html?shim=~%2F.wsp%2Fbin%2Fwsp", page)).toBe(true);
  });

  it("refuses the host's page, another file, a missing frame and an unparsable url", () => {
    expect(fromOnboardingPage("http://127.0.0.1:4400/", page)).toBe(false);
    expect(fromOnboardingPage("file:///Applications/wsp.app/Contents/Resources/app/main/other.html", page)).toBe(false);
    expect(fromOnboardingPage("file:///Users/me/onboarding.html", page)).toBe(false);
    expect(fromOnboardingPage(undefined, page)).toBe(false);
    expect(fromOnboardingPage("not a url", page)).toBe(false);
  });
});

describe("what a page may ask the shell for", () => {
  const here = { url: "http://127.0.0.1:4400", remote: false };
  const away = { url: "http://box.example:4400", remote: true };
  /** Its own device token, the hosts list, a move home, and the shell's own presentation. */
  const REMOTE = ["hosts:token", "hosts:list", "hosts:switch", "menu:context", "terminal:focus", "theme:set", "needs-you:say"];
  /** This computer's files, its pictures, its picker and the download of a new app. */
  const HERE_ONLY = ["fonts:local", "folder:pick", "preview:capture", "preview:read", "drop:allowed", "bundle:get", "bundle:open"];

  it("a page served by a host somewhere else reaches the narrow set and nothing of this computer", () => {
    for (const channel of REMOTE) expect(allowed(`${away.url}/`, away, channel)).toBe(true);
    for (const channel of HERE_ONLY) expect(allowed(`${away.url}/`, away, channel)).toBe(false);
  });

  it("the app's own host's page reaches every channel, and a page of any other origin reaches none", () => {
    for (const channel of [...REMOTE, ...HERE_ONLY]) {
      expect(allowed(`${here.url}/workspaces/w1`, here, channel)).toBe(true);
      expect(allowed("http://evil.example/", here, channel)).toBe(false);
      expect(allowed(`${away.url}/`, here, channel)).toBe(false);
      expect(allowed(`${here.url}/`, undefined, channel)).toBe(false);
      expect(allowed(undefined, here, channel)).toBe(false);
    }
  });

  it("names the channel it refused and nothing else", () => {
    expect(notForThisPage("fonts:local")).toBe("fonts:local: not for this page");
  });
});

describe("hostsViewFor", () => {
  const listing = (alias: string) => ({ alias, url: `http://${alias}:4400` });
  const view = { here: "This Mac", current: "box", hosts: [listing("box"), listing("attic")] };

  it("shows a page on a host somewhere else this computer and the host it came from, and no other saved host", () => {
    expect(hostsViewFor({ url: "http://box:4400", remote: true }, view)).toEqual({ here: "This Mac", current: "box", hosts: [listing("box")] });
  });

  it("shows the app's own host's page every saved host, which is what the shell's own menu draws", () => {
    expect(hostsViewFor({ url: "http://127.0.0.1:4400", remote: false }, view)).toEqual(view);
  });
});
