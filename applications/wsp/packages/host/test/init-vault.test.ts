// SPDX-License-Identifier: AGPL-3.0-only
// The vault step over a fake terminal: a token row runs its mint here and
// nothing on a machine, the pasted value lands in the wsp home's .env at mode
// 0600, a paste that is not what the tool prints is refused, and a value the
// file already holds is signed in with nothing asked.
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { ManifestEntry } from "@wsp/collect";
import { savedEnv, writeEnvFile } from "../src/env-keys.js";
import { vaultRows, vaultStage } from "../src/init-vault.js";

const TOKEN = "sk-ant-oat01-TESTONLYaaaaaaaaaaaaaaaaaaaa";
const KEY = { enter: "\r" };

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const text = () => stripVTControlCharacters(chunks.join(""));
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      input.write(k);
      await new Promise(r => setTimeout(r, 5));
    }
  };
  const until = async (needle: string, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (text().includes(needle)) return;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`never saw ${needle} in:\n${text()}`);
  };
  return { input, output, text, press, until };
}

const row = (id: string, label: string): ManifestEntry => ({ rung: "logins", id, label, group: "Agent logins", paths: [], bytes: 0, default: "skip" });
const manifest = { entries: [row("logins/claude", "Claude Code login"), row("logins/codex", "Codex login"), row("logins/gh", "GitHub CLI login")] };

describe("the rows the vault step owns", () => {
  it("is a token row answered token and a key row answered key, each with the variable its catalog row declares", () => {
    const choices = new Map([["logins/claude", "token"], ["logins/codex", "key"], ["logins/gh", "machine"]]);
    expect(vaultRows(manifest, choices).map(r => [r.entry.id, r.name, r.word, r.mint])).toEqual([
      ["logins/claude", "CLAUDE_CODE_OAUTH_TOKEN", "token", "claude setup-token"],
      ["logins/codex", "OPENAI_API_KEY", "API key", undefined],
    ]);
    expect(vaultRows(manifest, new Map([["logins/gh", "copy"]]))).toEqual([]);
  });
});

describe("the vault step", () => {
  const home = () => mkdtempSync(join(tmpdir(), "wsp-vault-"));

  it("runs the mint here, saves the pasted token to the wsp home's .env at 0600 and touches no machine", async () => {
    const dir = home();
    const env = join(dir, ".env");
    const t = terminal();
    const minted: string[] = [];
    const hidden: string[] = [];
    const run = vaultStage({
      rows: vaultRows(manifest, new Map([["logins/claude", "token"]])),
      held: () => ({}),
      save: set => writeEnvFile(env, set),
      mint: async command => void minted.push(command),
      input: t.input,
      output: t.output,
      hide: v => hidden.push(v),
    });
    await t.until("Claude Code token");
    await t.press(...TOKEN.split(""), KEY.enter);
    const outcomes = await run;
    expect(minted).toEqual(["claude setup-token"]);
    expect(outcomes).toEqual([{ id: "logins/claude", label: "Claude Code login", state: "signed-in", note: "token held on this computer" }]);
    expect(savedEnv(join(dir, "state.json"))).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(hidden).toEqual([TOKEN]);
    // The value is never on the screen.
    expect(t.text()).not.toContain(TOKEN);
  });

  it("takes the token out of the paste and nothing around it: a line copied with the tool's prompt is refused", async () => {
    const dir = home();
    const t = terminal();
    const run = vaultStage({
      rows: vaultRows(manifest, new Map([["logins/claude", "token"]])),
      held: () => ({}),
      save: set => writeEnvFile(join(dir, ".env"), set),
      mint: async () => {},
      input: t.input,
      output: t.output,
    });
    await t.until("Claude Code token");
    await t.press(...`Paste code here if prompted > ${TOKEN}`.split(""), KEY.enter);
    const outcomes = await run;
    expect(outcomes[0]!.state).toBe("not-signed-in");
    expect(savedEnv(join(dir, "state.json"))).toEqual({});
  });

  it("refuses a paste that is not what the tool prints, and saves nothing for that row", async () => {
    const dir = home();
    const t = terminal();
    const run = vaultStage({
      rows: vaultRows(manifest, new Map([["logins/claude", "token"]])),
      held: () => ({}),
      save: set => writeEnvFile(join(dir, ".env"), set),
      mint: async () => {},
      input: t.input,
      output: t.output,
    });
    await t.until("Claude Code token");
    await t.press(..."my password".split(""), KEY.enter);
    const outcomes = await run;
    expect(outcomes[0]!.state).toBe("not-signed-in");
    expect(outcomes[0]!.note).toContain("not what claude setup-token prints");
    expect(savedEnv(join(dir, "state.json"))).toEqual({});
  });

  it("asks nothing for a value the wsp home already holds, and nothing at all where nobody can type", async () => {
    const t = terminal();
    const rows = vaultRows(manifest, new Map([["logins/claude", "token"]]));
    const held = await vaultStage({ rows, held: () => ({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }), save: () => expect.unreachable("nothing to save"), input: t.input, output: t.output });
    expect(held).toEqual([{ id: "logins/claude", label: "Claude Code login", state: "signed-in", note: "token held on this computer" }]);

    const quiet = terminal();
    const none = await vaultStage({ rows, held: () => ({}), save: () => expect.unreachable("nothing to save"), input: quiet.input, output: quiet.output, skipWhy: "--yes asks nothing" });
    expect(none).toEqual([{ id: "logins/claude", label: "Claude Code login", state: "not-signed-in", note: "--yes asks nothing" }]);
  });
});
