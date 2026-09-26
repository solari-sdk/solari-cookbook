// SPDX-License-Identifier: AGPL-3.0-only
// Where each tool's login lives on the machine: every row that has one names
// it, the paths are home-relative, and the reader turns them into guest paths.
import { describe, expect, it } from "vitest";
import { CATALOG, CATALOG_AGENTS, GUEST_HOME, NEVER_IN_IMAGE, NO_SIGN_IN, SHARED_LOGINS, SIGN_IN_ROWS, VAULT_VARIABLES, catalogEntry, hasLogin, keyEnvOf, livesOnComputer, loginHomeIn, loginSignIn, loginStatePaths, mintsToken, sharedLoginOf, sharesIn, tokenIn, type SignIn } from "../src/index.js";

describe("sign-in state on the machine", () => {
  it("every row with a login or a source names at least one path, home-relative and with no ..", () => {
    for (const [id, row] of Object.entries(SIGN_IN_ROWS as Record<string, SignIn>)) {
      // A login that lives on the computer that runs the workspaces keeps no state on any machine.
      if ((!hasLogin(row) && row.sources.length === 0) || livesOnComputer(row)) continue;
      const paths = row.stateOnMachine ?? [];
      expect(paths.length, `${id} names no state on the machine`).toBeGreaterThan(0);
      for (const p of paths) {
        expect(p.startsWith("/"), `${id}'s ${p} is not home-relative`).toBe(false);
        expect(p.startsWith("~"), `${id}'s ${p} is not home-relative`).toBe(false);
        expect(p.split("/"), `${id}'s ${p} climbs out of the home`).not.toContain("..");
      }
    }
  });

  it("loginStatePaths answers guest paths under the guest home, and nothing for an entry with no sign-in", () => {
    expect(loginStatePaths(catalogEntry("gh")!)).toEqual([`${GUEST_HOME}/.config/gh/hosts.yml`]);
    expect(loginStatePaths(catalogEntry("gemini")!)).toEqual([`${GUEST_HOME}/.gemini/oauth_creds.json`]);
    expect(loginStatePaths({ signIn: NO_SIGN_IN })).toEqual([]);
    for (const entry of CATALOG) for (const p of loginStatePaths(entry)) expect(p.startsWith(`${GUEST_HOME}/`)).toBe(true);
  });

  it("Claude's login and Codex's have no state on the machine: one is a token held on this computer, the other signs in on the box", () => {
    expect(loginStatePaths(catalogEntry("claude")!)).toEqual([]);
    expect(loginStatePaths(catalogEntry("codex")!)).toEqual([]);
  });
});

describe("the token sign-in and the vault", () => {
  it("Claude's row mints a token on this computer and nothing of it travels", () => {
    const s = SIGN_IN_ROWS.claude;
    expect(s.kind).toBe("token");
    expect(mintsToken(s)).toBe(true);
    expect(hasLogin(s)).toBe(false);
    expect(s.mint).toBe("claude setup-token");
    expect(s.tokenEnv).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(s.token.test("sk-ant-oat01-TESTONLYaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(s.token.test("not-a-token")).toBe(false);
    expect(s.sources).toEqual([]);
    expect(s.stateOnMachine).toEqual([]);
  });

  it("Codex's login lives on the computer that runs the workspaces and is never copied onto a builder", () => {
    const s = SIGN_IN_ROWS.codex;
    expect(livesOnComputer(s)).toBe(true);
    expect(s.sources).toEqual([]);
    expect(s.stateOnMachine).toEqual([]);
    expect(livesOnComputer(SIGN_IN_ROWS.gh)).toBe(false);
  });

  it("the key variable a row reads is written once, and a row that reads none says so", () => {
    expect(keyEnvOf(SIGN_IN_ROWS.claude)).toBe("ANTHROPIC_API_KEY");
    expect(keyEnvOf(SIGN_IN_ROWS.codex)).toBe("OPENAI_API_KEY");
    expect(keyEnvOf(SIGN_IN_ROWS.gemini)).toBe("GEMINI_API_KEY");
    expect(keyEnvOf(SIGN_IN_ROWS.gh)).toBeUndefined();
    expect(keyEnvOf(NO_SIGN_IN)).toBeUndefined();
  });

  it("the token in a paste is the whole of it and nothing around it, trimmed", () => {
    const row = SIGN_IN_ROWS.claude;
    const token = "sk-ant-oat01-TESTONLYaaaaaaaaaaaaaaaaaaaa";
    expect(tokenIn(row, `  ${token}\n`)).toBe(token);
    // A line copied with the tool's own words around it is not a token, so nothing of it is saved.
    expect(tokenIn(row, `Paste code here if prompted > ${token}`)).toBeUndefined();
    expect(tokenIn(row, `${token} # my token`)).toBeUndefined();
    expect(tokenIn(row, "my password")).toBeUndefined();
    expect(tokenIn(row, "")).toBeUndefined();
  });

  it("a manifest's login row reads its catalog sign-in by one rule, with or without the rung in front", () => {
    expect(loginSignIn("logins/claude")).toBe(SIGN_IN_ROWS.claude);
    expect(loginSignIn("claude")).toBe(SIGN_IN_ROWS.claude);
    // The collector files kubectl's login under its kubeconfig, which is the name its row carries.
    expect(loginSignIn("logins/kube")).toBe(SIGN_IN_ROWS.kubectl);
    expect(loginSignIn("logins/nothing-here")).toBeUndefined();
    expect(loginSignIn("agents/claude")).toBeUndefined();
  });

  it("the vault holds the agents' token and key variables and nothing else", () => {
    expect([...VAULT_VARIABLES].sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GEMINI_API_KEY", "OPENAI_API_KEY"]);
    const declared = new Set(CATALOG_AGENTS.flatMap(a => [...(mintsToken(a.signIn) ? [a.signIn.tokenEnv] : []), ...("keyEnv" in a.signIn && a.signIn.keyEnv !== undefined ? [a.signIn.keyEnv] : [])]));
    for (const name of VAULT_VARIABLES) expect(declared.has(name), `${name} is in the vault but no agent row declares it`).toBe(true);
  });

  it("the paths a builder may never hold are absolute guest paths: the Claude credential, the helper key file and the Codex login", () => {
    expect(NEVER_IN_IMAGE).toEqual([`${GUEST_HOME}/.claude-cfg/.credentials.json`, `${GUEST_HOME}/.claude-cfg/anthropic-api-key`, `${GUEST_HOME}/.codex/auth.json`]);
    for (const p of NEVER_IN_IMAGE) expect(p.startsWith(`${GUEST_HOME}/`)).toBe(true);
    // The shared login's own path is not spelled twice: what a workspace reads it at is what may not be sealed.
    for (const shared of SHARED_LOGINS) expect(NEVER_IN_IMAGE).toContain(shared.target);
  });
});

describe("a login signed in once on the computer that runs the workspaces", () => {
  it("Codex declares the file it shares, where the tool reads it inside and the variable its store is named by", () => {
    const shared = sharedLoginOf(SIGN_IN_ROWS.codex);
    expect(shared).toEqual({ dir: "codex", file: "auth.json", target: `${GUEST_HOME}/.codex/auth.json`, homeEnv: "CODEX_HOME" });
    // The predicate and the declaration are one thing: a row that shares nothing lives in the image as before.
    expect(livesOnComputer(SIGN_IN_ROWS.codex)).toBe(true);
    expect(sharedLoginOf(SIGN_IN_ROWS.gh)).toBeUndefined();
    expect(sharedLoginOf(SIGN_IN_ROWS.claude)).toBeUndefined();
    expect(SHARED_LOGINS).toEqual([shared]);
  });

  it("what a create shares into a workspace is that computer's own file at the path the tool reads, and the sign-in runs against the same directory", () => {
    expect(sharesIn("/var/lib/wsp/logins")).toEqual([{ source: "/var/lib/wsp/logins/codex/auth.json", target: `${GUEST_HOME}/.codex/auth.json` }]);
    // The sign-in on that computer runs with the tool's store pointed here, which is where the shared file lands.
    expect(loginHomeIn("/var/lib/wsp/logins", sharedLoginOf(SIGN_IN_ROWS.codex)!)).toBe("/var/lib/wsp/logins/codex");
    for (const share of sharesIn("/var/lib/wsp/logins")) expect(share.source.startsWith("/var/lib/wsp/logins/")).toBe(true);
  });
});
