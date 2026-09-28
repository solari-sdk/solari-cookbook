// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DaemonEvent, DaemonRequest, GoldenVersion, HTTP_URL_MAX, HTTP_URL_RE, callbackPortOf, hostOf, isHttpUrl, redirectsToMachine } from "../src/index.js";

// URLs as the tools build them (measurement 2026-09-03); client ids are cut and state and challenge values are placeholders.
const WRANGLER =
  "https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d11594&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Foauth%2Fcallback&scope=account%3Aread&state=S&code_challenge=C&code_challenge_method=S256";
const CLAUDE_BROWSER =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A45543%2Fcallback&scope=user%3Ainference&code_challenge=C&code_challenge_method=S256&state=S";
const CLAUDE_TERMINAL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=C&code_challenge_method=S256&state=S";
// gcloud auth login with a browser to reach, and the page it prints instead when it has none: the same authorize
// endpoint, one redirecting to a port on the machine, the other to the page that shows a code to paste.
const GCLOUD_BROWSER =
  "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F&scope=openid+email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform&state=S&access_type=offline&code_challenge=C&code_challenge_method=S256";
const GCLOUD_PASTE =
  "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559&redirect_uri=https%3A%2F%2Fsdk.cloud.google.com%2FauthCode.html&scope=openid+email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform&state=S&access_type=offline&code_challenge=C&code_challenge_method=S256";
const AWS = "https://d-1234.awsapps.com/start/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A53211%2Foauth%2Fcallback&state=S";
const MCP_REMOTE =
  "https://mcp.linear.app/authorize?response_type=code&client_id=X&code_challenge=C&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A22227%2Foauth%2Fcallback&state=S&scope=read+write&resource=https%3A%2F%2Fmcp.linear.app%2Fmcp";
const IPV6 = "https://example.com/authorize?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A8976%2Foauth%2Fcallback&state=S";
const GH_DEVICE = "https://github.com/login/device";
const AWS_BARE = "https://d-1234.awsapps.com/start/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%2Foauth%2Fcallback&state=S";
const KEYCHAIN_STYLE = "https://accounts.example.com/oauth2/auth?client_id=keychain&scope=openid";
const REMOTE_PORT = "https://example.com/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%3A8443%2Fcb";

// The two readings of a redirect_uri, in one home: whether the page comes back to the machine at all, which tells
// the sign-in hand-off which road a login is on, and which port it names, which the daemon puts on a browser.open.
describe("redirectsToMachine", () => {
  it.each([
    ["wrangler's localhost callback", WRANGLER, true],
    ["gcloud with a browser to reach", GCLOUD_BROWSER, true],
    ["aws sso, 127.0.0.1 with a port", AWS, true],
    ["aws's registered redirect without a port, whose listener the spotter finds", AWS_BARE, true],
    ["an IPv6 loopback host", IPV6, true],
    ["gcloud with no browser: its page hands a code back", GCLOUD_PASTE, false],
    ["Claude Code's hosted paste-code callback", CLAUDE_TERMINAL, false],
    ["gh's device page: no redirect_uri at all", GH_DEVICE, false],
    ["a redirect_uri on another host, even with a port", REMOTE_PORT, false],
    ["not a URL", "paste code here", false],
  ])("%s", (_name, url, returns) => {
    expect(redirectsToMachine(url)).toBe(returns);
  });
});

describe("callbackPortOf", () => {
  it.each([
    ["wrangler, redirect_uri on localhost:8976", WRANGLER, 8976],
    ["Claude Code's browser URL, random localhost port", CLAUDE_BROWSER, 45543],
    ["gcloud with a browser to reach: the port it listens on", GCLOUD_BROWSER, 8085],
    ["aws sso, 127.0.0.1 with a port", AWS, 53211],
    ["mcp-remote, port derived from the server URL", MCP_REMOTE, 22227],
    ["an IPv6 loopback host", IPV6, 8976],
    ["gcloud with no browser: its page hands a code back, so nothing returns to the machine", GCLOUD_PASTE, undefined],
    ["Claude Code's printed URL: the hosted paste-code callback", CLAUDE_TERMINAL, undefined],
    ["gh's device page: no redirect_uri at all", GH_DEVICE, undefined],
    ["aws's registered redirect without a port: it comes back to the machine, but names no port to bind", AWS_BARE, undefined],
    ["a bare authorize URL with neither redirect_uri nor port", KEYCHAIN_STYLE, undefined],
    ["a redirect_uri on another host, even with a port", REMOTE_PORT, undefined],
    ["a loopback port below 1024, which the laptop could not bind", "https://x.test/a?redirect_uri=http%3A%2F%2Flocalhost%3A80%2Fcb", undefined],
    ["not a URL", "paste code here", undefined],
    ["a redirect_uri that is not a URL", "https://x.test/a?redirect_uri=nonsense", undefined],
  ])("%s", (_name, url, port) => {
    expect(callbackPortOf(url)).toBe(port);
  });
});

describe("callback relay wire shapes", () => {
  it("browser.open carries the URL and, when the redirect_uri named one, the port", () => {
    const bare = { type: "browser.open", url: "https://github.com/login/device" };
    expect(DaemonEvent.parse(bare)).toEqual(bare);
    const withPort = { type: "browser.open", url: "https://dash.example.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Fcb", port: 8976 };
    expect(DaemonEvent.parse(withPort)).toEqual(withPort);
    expect(() => DaemonEvent.parse({ type: "browser.open" })).toThrow();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "\\\\host\\share", "ftp://x/y"]) {
      expect(() => DaemonEvent.parse({ type: "browser.open", url })).toThrow();
    }
  });

  it("callback.port names a loopback listener; port.open may say it is loopback-bound", () => {
    expect(DaemonEvent.parse({ type: "callback.port", port: 45543 })).toEqual({ type: "callback.port", port: 45543 });
    expect(() => DaemonEvent.parse({ type: "callback.port" })).toThrow();
    const open = { type: "port.open", port: 8976, loopback: true };
    expect(DaemonEvent.parse(open)).toEqual(open);
    expect(DaemonEvent.parse({ type: "port.open", port: 3000 })).toEqual({ type: "port.open", port: 3000 });
  });

  it("tunnel ops and events: open by id and port, base64 data both ways, end from the guest", () => {
    expect(DaemonRequest.parse({ id: 1, op: "tunnel.open", tunnelId: "t1", port: 8976 })).toEqual({ id: 1, op: "tunnel.open", tunnelId: "t1", port: 8976 });
    expect(() => DaemonRequest.parse({ id: 1, op: "tunnel.open", tunnelId: "t1", port: 0 })).toThrow();
    expect(() => DaemonRequest.parse({ id: 1, op: "tunnel.open", tunnelId: "t1", port: 70000 })).toThrow();
    expect(DaemonRequest.parse({ id: 2, op: "tunnel.write", tunnelId: "t1", data: "aGk=" })).toEqual({ id: 2, op: "tunnel.write", tunnelId: "t1", data: "aGk=" });
    expect(DaemonRequest.parse({ id: 3, op: "tunnel.close", tunnelId: "t1" })).toEqual({ id: 3, op: "tunnel.close", tunnelId: "t1" });
    expect(DaemonEvent.parse({ type: "tunnel.data", tunnelId: "t1", data: "aGk=" })).toEqual({ type: "tunnel.data", tunnelId: "t1", data: "aGk=" });
    expect(DaemonEvent.parse({ type: "tunnel.end", tunnelId: "t1" })).toEqual({ type: "tunnel.end", tunnelId: "t1" });
  });

  it("isHttpUrl is the one rule: http or https in any case, nothing else, and browser.open follows it", () => {
    expect(isHttpUrl("HTTPS://EXAMPLE.COM/A")).toBe(true);
    expect(isHttpUrl("Http://x.test")).toBe(true);
    expect(isHttpUrl("https://github.com/login/device")).toBe(true);
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "\\\\host\\share", "ftp://x/y", "", 42, undefined, "httpss://x"]) {
      expect(isHttpUrl(bad)).toBe(false);
    }
    expect(DaemonEvent.parse({ type: "browser.open", url: "HTTPS://EXAMPLE.COM/A" })).toEqual({ type: "browser.open", url: "HTTPS://EXAMPLE.COM/A" });
  });

  it("isHttpUrl also caps the length and refuses whitespace and control characters, on every side", () => {
    const long = `https://x.test/${"a".repeat(HTTP_URL_MAX)}`;
    expect(isHttpUrl(long)).toBe(false);
    expect(isHttpUrl(`https://x.test/${"a".repeat(HTTP_URL_MAX - 15)}`)).toBe(true);
    for (const bad of ["https://x.test/a b", "https://x.test/a\nb", "https://x.test/\tq", "https://x.test/\x00", "https://x.test/\x7f", "https://x.test/a\r"]) {
      expect(isHttpUrl(bad)).toBe(false);
      expect(() => DaemonEvent.parse({ type: "browser.open", url: bad })).toThrow();
    }
    expect(HTTP_URL_RE.flags).toBe("i");
  });

  it("isHttpUrl also requires the URL to parse, so a hostname can always be read from it", () => {
    for (const bad of ["https://%", "https://[::1", "https://exa%mple.com/x"]) {
      expect(isHttpUrl(bad)).toBe(false);
      expect(() => DaemonEvent.parse({ type: "browser.open", url: bad })).toThrow();
    }
    expect(isHttpUrl("https://[::1]:8976/cb")).toBe(true);
  });

  it("hostOf reads the host (with its port, without userinfo) and returns undefined instead of throwing", () => {
    expect(hostOf("https://github.com/login/device")).toBe("github.com");
    expect(hostOf("https://github.com:8443/x")).toBe("github.com:8443");
    expect(hostOf("https://github.com@evil.example/login")).toBe("evil.example");
    expect(hostOf("https://[::1]:8976/cb")).toBe("[::1]:8976");
    for (const bad of ["https://%", "https://[::1", "not a url", ""]) expect(hostOf(bad)).toBeUndefined();
  });

  it("relay ports on the wire are integers in 1024..65535, on browser.open and callback.port alike", () => {
    for (const port of [1024, 8976, 65535]) {
      expect(DaemonEvent.parse({ type: "callback.port", port })).toEqual({ type: "callback.port", port });
      expect(DaemonEvent.parse({ type: "browser.open", url: "https://x.test/a", port })).toEqual({ type: "browser.open", url: "https://x.test/a", port });
    }
    for (const port of [70000, 65536, 1023, 80, 0, 1.5, -1]) {
      expect(() => DaemonEvent.parse({ type: "callback.port", port })).toThrow();
      expect(() => DaemonEvent.parse({ type: "browser.open", url: "https://x.test/a", port })).toThrow();
    }
  });

  it("a golden version may say it was sealed with the browser shim; older versions carry no flag", () => {
    const base = { version: 1, snapshotId: "s", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-04T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } };
    expect(GoldenVersion.parse(base)).toEqual(base);
    expect(GoldenVersion.parse({ ...base, browserShim: true })).toEqual({ ...base, browserShim: true });
    expect(() => GoldenVersion.parse({ ...base, browserShim: "yes" })).toThrow();
  });
});
