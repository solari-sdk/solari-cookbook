// SPDX-License-Identifier: AGPL-3.0-only
// The vault at a turn's launch: the variables the wsp home's .env holds reach
// every adapter through the runtime, read at each launch and never copied, so
// a token minted after the host started is in the next turn. Nothing of it is
// on a machine.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import type { HarnessAdapterContext, HarnessAdapterFactory, LocalWiring } from "../src/runtime.js";
import { createRuntime } from "../src/runtime.js";
import { secretsOf } from "../src/adapters.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, copyingFake, createOn, tempRepo, testPlatform } from "./stub-backend.js";
import { TURN_TOKEN_ENV, type TurnResult } from "@wsp/protocol";
import { buildEnv } from "@wsp/adapter-claude";

/** A folder with a first commit in it, which is what a project on this computer is made of. */
function repoAt(): string {
  const at = tempRepo();
  execFileSync("git", ["-C", at, "commit", "-q", "--allow-empty", "-m", "first"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  return at;
}

const TOKEN = "sk-ant-oat01-TESTONLY";
const OPENAI = "sk-x-fake-openai";

/** An adapter that reports every context it was built with and ends its turn at once. */
function recording(): { factory: HarnessAdapterFactory; contexts: HarnessAdapterContext[] } {
  const contexts: HarnessAdapterContext[] = [];
  const factory: HarnessAdapterFactory = ctx => {
    contexts.push(ctx);
    return {
      steers: false,
      start: ({ onEvent }) => {
        const sessionId = randomUUID();
        const result: TurnResult = { status: "completed", text: "ok" };
        onEvent({ type: "session.start", sessionId });
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
      },
    };
  };
  return { factory, contexts };
}

describe("the vault a turn launches with", () => {
  it("reaches a turn on a cloud fork, read at the launch, so a token minted after the host started is in the next turn", async () => {
    const { factory, contexts } = recording();
    let held: Record<string, string> = {};
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory }, vault: () => held });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    expect(contexts.at(-1)!.vault).toEqual({});
    held = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
    await (await rt.sessions.start(ws.id, { prompt: "two" })).finished;
    expect(contexts.at(-1)!.vault).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  });

  it("sets every name an MCP server's definition reads in the turn's environment, and a row's token only through the row", async () => {
    const { factory, contexts } = recording();
    const held = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, WSP_MCP_LINEAR_AUTHORIZATION: "lin_api_TESTONLY", NOTION_TOKEN: "ntn_TESTONLY" };
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory }, vault: () => held });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    const env = contexts.find(c => TURN_TOKEN_ENV in c.env)!.env;
    // Every other road an adapter is built for starts no agent, so no server value rides it.
    for (const c of contexts.filter(c => !(TURN_TOKEN_ENV in c.env))) expect(c.env["WSP_MCP_LINEAR_AUTHORIZATION"]).toBeUndefined();
    expect(env).toMatchObject({ WSP_MCP_LINEAR_AUTHORIZATION: "lin_api_TESTONLY", NOTION_TOKEN: "ntn_TESTONLY" });
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    // Claude Code's own environment is the one it expands ${WSP_MCP_LINEAR_AUTHORIZATION} out of.
    expect(buildEnv({ base: env })).toMatchObject({ WSP_MCP_LINEAR_AUTHORIZATION: "lin_api_TESTONLY", NOTION_TOKEN: "ntn_TESTONLY" });
  });

  it("is empty for a host that wired none, so a turn carries nothing of one", async () => {
    const { factory, contexts } = recording();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory } });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    for (const ctx of contexts) expect(ctx.vault).toEqual({});
  });

  it("reads a login on the computer the app runs on off that agent's own store there, and never on a fork", async () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-login-"));
    const codexHome = join(root, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const { factory, contexts } = recording();
    const local: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: id => join(root, `.${id}`),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory }, local });
    const folder = repoAt();
    const project = await rt.projects.add({ source: folder });
    const here = await rt.workspaces.create({ project: project.id, name: "here" });
    await (await rt.sessions.start(here.id, { prompt: "one" })).finished;
    // Nothing under the home Codex reads on this computer, so a key the vault holds is the turn's to run on.
    expect(contexts.at(-1)!.loginStands("codex")).toBe(false);

    writeFileSync(join(codexHome, "auth.json"), "{}");
    await (await rt.sessions.start(here.id, { prompt: "two" })).finished;
    expect(contexts.at(-1)!.loginStands("codex")).toBe(true);
    // Claude Code keeps no shared login file at all, so there is never one of its own to stand here.
    expect(contexts.at(-1)!.loginStands("claude")).toBe(false);

    // An image never carries a sign-in, so a fork at a provider always takes the vault's key.
    const cloud = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory } });
    const fork = await createOn(cloud, { golden: "snap_g", name: "x" });
    await (await cloud.sessions.start(fork.id, { prompt: "one" })).finished;
    expect(contexts.at(-1)!.loginStands("codex")).toBe(false);
    for (const at of [root, folder]) rmSync(at, { recursive: true, force: true });
  });

  it("hands each agent the variables its own catalog row declares, from one record, and its token in place of its key", () => {
    const record = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: OPENAI, SOLARI_API_KEY: "slr_live_x" };
    // An API key beside the token would win inside Claude Code and bill the key on every turn, so the vault hands
    // the token alone where it holds one.
    expect(secretsOf(record, "claude")).toEqual({ oauthToken: TOKEN });
    // The key comes back with the variable it travels under, since the sentence for a key the provider turns down
    // has to name it.
    expect(secretsOf(record, "codex")).toEqual({ apiKey: OPENAI, keyEnv: "OPENAI_API_KEY" });
    expect(secretsOf({ ANTHROPIC_API_KEY: "sk-ant-x" }, "claude")).toEqual({ apiKey: "sk-ant-x", keyEnv: "ANTHROPIC_API_KEY" });
    expect(secretsOf({}, "claude")).toEqual({});
    expect(secretsOf({}, "codex")).toEqual({});
  });

  it("holds the key back where a login of that agent's own already stands, since the key would outrank it", () => {
    const record = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, OPENAI_API_KEY: OPENAI };
    // Codex reads a key in its environment ahead of the login under its home, so a key handed on a computer the
    // person signed Codex in on would bill the key and leave that sign-in unused.
    expect(secretsOf(record, "codex", true)).toEqual({});
    expect(secretsOf(record, "codex", false)).toEqual({ apiKey: OPENAI, keyEnv: "OPENAI_API_KEY" });
    // The token is not a key and no login on a machine stands against it: Claude Code keeps none there at all.
    expect(secretsOf(record, "claude", true)).toEqual({ oauthToken: TOKEN });
  });
});
