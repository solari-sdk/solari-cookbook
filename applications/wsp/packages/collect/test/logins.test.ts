// SPDX-License-Identifier: AGPL-3.0-only
import { CATALOG, LOGIN_ROWS, loginIdOf } from "@wsp/catalog";
import { describe, expect, it } from "vitest";
import { detectLogins } from "../src/index.js";
import { loginDefault } from "../src/detect/logins.js";
import { fakeHost } from "./fake-host.js";

describe("logins", () => {
  it.each([
    ["gh with its token in hosts.yml", "darwin", { "~/.config/gh/hosts.yml": 200 }, {}, "logins/gh", ["~/.config/gh/hosts.yml"], "skip"],
    ["gcloud", "darwin", { "~/.config/gcloud/credentials.db": 4000, "~/.config/gcloud/configurations/config_default": 50, "~/.config/gcloud/logs/x.log": 9999 }, {}, "logins/gcloud", ["~/.config/gcloud/credentials.db", "~/.config/gcloud/configurations"], "skip"],
    ["wrangler on macOS", "darwin", { "~/Library/Preferences/.wrangler/config/default.toml": 300 }, {}, "logins/wrangler", ["~/Library/Preferences/.wrangler/config/default.toml"], "skip"],
    ["wrangler on Linux", "linux", { "~/.config/.wrangler/config/default.toml": 300 }, {}, "logins/wrangler", ["~/.config/.wrangler/config/default.toml"], "skip"],
    ["cloudflared", "darwin", { "~/.cloudflared/cert.pem": 800 }, {}, "logins/cloudflared", ["~/.cloudflared/cert.pem"], "skip"],
    ["vercel on macOS", "darwin", { "~/Library/Application Support/com.vercel.cli/auth.json": 100 }, {}, "logins/vercel", ["~/Library/Application Support/com.vercel.cli/auth.json"], "skip"],
    ["vercel on Linux", "linux", { "~/.config/com.vercel.cli/auth.json": 100 }, {}, "logins/vercel", ["~/.config/com.vercel.cli/auth.json"], "skip"],
    ["aws", "darwin", { "~/.aws/credentials": 120, "~/.aws/config": 300, "~/.aws/sso/cache/x.json": 900 }, {}, "logins/aws", ["~/.aws/credentials", "~/.aws/config"], "skip"],
    ["kubectl", "darwin", { "~/.kube/config": 6000 }, {}, "logins/kube", ["~/.kube/config"], "bring"],
    ["Gemini CLI", "darwin", { "~/.gemini/oauth_creds.json": 500 }, {}, "logins/gemini", ["~/.gemini/oauth_creds.json"], "skip"],
    ["OpenCode", "darwin", { "~/.local/share/opencode/auth.json": 200 }, {}, "logins/opencode", ["~/.local/share/opencode/auth.json"], "bring"],
    ["Pi", "darwin", { "~/.pi/agent/auth.json": 900, "~/.pi/agent/settings.json": 80 }, {}, "logins/pi", ["~/.pi/agent/auth.json"], "skip"],
  ])("%s: presence by path; a browser or device sign-in starts as a sign-in on the machine (skip), a key or no sign-in as a copy (bring)", async (_name, platform, files, exec, id, paths, dflt) => {
    const rows = await detectLogins(fakeHost({ platform: platform === "linux" ? "linux" : "darwin", files, exec }));
    expect(rows).toEqual([{ rung: "logins", id, label: expect.any(String), group: expect.any(String), paths, bytes: expect.any(Number), default: dflt }]);
  });

  it("Codex is found by its file and offers nothing of it: its login lives on the computer that runs the workspaces", async () => {
    expect(await detectLogins(fakeHost({ files: { "~/.codex/auth.json": 900 } }))).toEqual([
      { rung: "logins", id: "logins/codex", label: "Codex login", group: "Agent logins", paths: [], bytes: 0, default: "skip", detail: "it signs in once on the computer that runs your workspaces; nothing of it travels" },
    ]);
  });

  it("Hermes Agent is two rows: its device login, a sign-in on the machine, and the keys file beside it, a copy the row explains", async () => {
    const rows = await detectLogins(fakeHost({ files: { "~/.hermes/.env": 25_000, "~/.hermes/auth.json": 400, "~/.hermes/config.yaml": 600 } }));
    expect(rows).toEqual([
      { rung: "logins", id: "logins/hermes", label: "Hermes Agent login", group: "Agent logins", paths: ["~/.hermes/auth.json"], bytes: 400, default: "skip" },
      { rung: "logins", id: "logins/hermes-keys", label: "Hermes Agent API keys", group: "Agent logins", paths: ["~/.hermes/.env"], bytes: 25_000, default: "bring", detail: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them" },
    ]);
    expect(loginDefault("hermes")).toBe("skip");
    expect(loginDefault("hermes-keys")).toBe("bring");
    // Each row stands on its own file: keys with no login, a login with no keys.
    expect((await detectLogins(fakeHost({ files: { "~/.hermes/.env": 100 } }))).map(r => r.id)).toEqual(["logins/hermes-keys"]);
    expect((await detectLogins(fakeHost({ files: { "~/.hermes/auth.json": 100 } }))).map(r => r.id)).toEqual(["logins/hermes"]);
  });

  it("every login row's default follows its catalog entry's sign-in kind, and a login the catalog does not know starts as a copy", () => {
    const travels = (k: string): boolean => k !== "oauth" && k !== "device" && k !== "token";
    for (const e of CATALOG) expect(loginDefault(loginIdOf(e.id)), e.id).toBe(travels(e.signIn.kind) ? "bring" : "skip");
    for (const r of LOGIN_ROWS) expect(loginDefault(r.id), r.id).toBe(travels(r.signIn.kind) ? "bring" : "skip");
    expect(CATALOG.find(e => e.id === "kubectl")?.signIn.kind).toBe("none");
    expect(loginDefault("kube")).toBe("bring");
    expect(loginDefault("opencode")).toBe("bring");
    expect(loginDefault("some-new-tool")).toBe("bring");
  });

  it("Claude Code's login is found here and nothing of it is offered to copy: the row names the token instead", async () => {
    const mac = await detectLogins(fakeHost({ exec: { 'security find-generic-password -s Claude Code-credentials': "keychain: ...\n" } }));
    expect(mac).toEqual([
      { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: [], bytes: 0, default: "skip", detail: "Claude Code signs in with the token claude setup-token prints on this computer; nothing of its login here travels" },
    ]);
    const linux = await detectLogins(fakeHost({ platform: "linux", files: { "~/.claude/.credentials.json": 800 } }));
    expect(linux).toEqual([
      { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: [], bytes: 0, default: "skip", detail: "Claude Code signs in with the token claude setup-token prints on this computer; nothing of its login here travels" },
    ]);
  });

  it("Claude Code with every key source here still travels nothing: the row is the token's, whatever is on this computer", async () => {
    const host = fakeHost({
      files: { "~/.zshrc": "export A=1\nexport ANTHROPIC_API_KEY=sk-ant-x\n", "~/.claude/settings.json": '{"apiKeyHelper": "security find-generic-password -s anthropic-api-key -w", "model": "opus"}' },
      exec: { 'security find-generic-password -s Claude Code-credentials': "keychain: ...\n" },
    });
    const rows = await detectLogins(host);
    expect(rows).toEqual([
      {
        rung: "logins",
        id: "logins/claude",
        label: "Claude Code login",
        group: "Agent logins",
        paths: [],
        bytes: 0,
        default: "skip",
        detail: "Claude Code signs in with the token claude setup-token prints on this computer; nothing of its login here travels",
      },
    ]);
  });

  it("an apiKeyHelper or an exported key here is a Claude row with nothing to copy either: the helper's key never travels", async () => {
    const helper = await detectLogins(fakeHost({ files: { "~/.claude/settings.json": '{"apiKeyHelper": "security find-generic-password -s anthropic-api-key -w"}' } }));
    expect(helper).toEqual([
      { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: [], bytes: 0, default: "skip", detail: "Claude Code signs in with the token claude setup-token prints on this computer; nothing of its login here travels" },
    ]);
    const exported = await detectLogins(fakeHost({ platform: "linux", files: { "~/.bashrc": "ANTHROPIC_API_KEY=sk-ant-x; export ANTHROPIC_API_KEY\n" } }));
    expect(exported).toEqual([
      { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: [], bytes: 0, default: "skip", detail: "Claude Code signs in with the token claude setup-token prints on this computer; nothing of its login here travels" },
    ]);
    // A settings.json without a helper, or one that is not JSON, is no source.
    expect(await detectLogins(fakeHost({ files: { "~/.claude/settings.json": '{"model": "opus"}' } }))).toEqual([]);
    expect(await detectLogins(fakeHost({ files: { "~/.claude/settings.json": "{ not json" } }))).toEqual([]);
  });

  it("gh with its token in the macOS Keychain carries that item as a second path and still starts as a sign-in on the machine", async () => {
    const host = fakeHost({ files: { "~/.config/gh/hosts.yml": 200 }, exec: { "security find-generic-password -s gh:github.com": "keychain: ...\n" } });
    const rows = await detectLogins(host);
    expect(rows).toEqual([
      { rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], bytes: 200, default: "skip" },
    ]);
  });

  it.each([
    ["gh with its token in the Keychain", { "~/.config/gh/hosts.yml": 200 }, { "security find-generic-password -s gh:github.com": "keychain: ...\n" }, "GitHub CLI login", undefined],
    ["aws", { "~/.aws/credentials": 120, "~/.aws/config": 300 }, {}, "AWS keys and profiles", undefined],
  ])("%s is labelled by name; any sentence about it is a detail, not part of the label", async (_name, files, exec, label, reason) => {
    const [row] = await detectLogins(fakeHost({ files, exec }));
    expect(row?.label).toBe(label);
    expect(row?.reason).toBe(reason);
    expect(row?.label).not.toMatch(/[()]/);
    expect(row?.label.length).toBeLessThanOrEqual(40);
  });

  it("1Password CLI is listed locked off", async () => {
    const rows = await detectLogins(fakeHost({ which: ["op"] }));
    expect(rows).toEqual([
      { rung: "logins", id: "logins/op", label: "1Password CLI", group: "CLI logins", paths: [], bytes: 0, default: "skip", reason: "needs the 1Password desktop app; the machine uses a service account token" },
    ]);
  });

  it("never reads a login file and never asks the Keychain for a secret; only the rc files and Claude's settings are read, for names", async () => {
    const host = fakeHost({
      files: { "~/.config/gh/hosts.yml": "oauth_token: x", "~/.codex/auth.json": "{}", "~/.aws/credentials": "k", "~/.hermes/.env": "ANTHROPIC_API_KEY=sk-ant-x", "~/.pi/agent/auth.json": "{}", "~/.zshrc": "export A=1\n" },
      exec: { 'security find-generic-password -s Claude Code-credentials': "x" },
    });
    await detectLogins(host);
    const reads = host.calls.filter(c => c.startsWith("read")).map(c => c.slice("read /Users/dev/".length));
    expect(reads).toContain(".zshrc");
    expect(reads.every(r => r === ".claude/settings.json" || r.startsWith(".config/fish/") || /^\.[a-z_]+$/.test(r))).toBe(true);
    expect(host.calls.filter(c => c.includes(" -w"))).toEqual([]);
  });

  it("no logins on an empty laptop", async () => {
    expect(await detectLogins(fakeHost())).toEqual([]);
  });
});
