import { describe, expect, it } from "vitest";

import { buildCommand, buildEnv, newSessionId, PROJECT_DIR_ENV, userMessageLine } from "../src/landmines.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("buildEnv", () => {
  const base = {
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SSE_PORT: "12345",
    FORCE_CODE_TERMINAL: "true",
    PATH: "/root/.local/bin:/usr/bin",
    HOME: "/Users/z",
  };

  it("strips inherited CLAUDE_CODE_*, CLAUDECODE and FORCE_CODE_TERMINAL", () => {
    const env = buildEnv({ base });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.FORCE_CODE_TERMINAL).toBeUndefined();
    expect(env.PATH).toBe(base.PATH);
  });

  it("drops an inherited project key and sets the one the caller named, after the strip", () => {
    // The strip takes every inherited CLAUDE_CODE_* as a nesting mark, so a key merged into the base is thrown
    // away; the key a workspace's own kind answers is set after it, which is what makes it reach the CLI.
    expect(buildEnv({ base: { ...base, [PROJECT_DIR_ENV]: "-Users-z-repo" } })[PROJECT_DIR_ENV]).toBeUndefined();
    const keyed = buildEnv({ base, projectDirName: "-Users-z-repo" });
    expect(keyed[PROJECT_DIR_ENV]).toBe("-Users-z-repo");
    // A base carrying its own is still dropped, and the named one is what is set.
    expect(buildEnv({ base: { ...base, [PROJECT_DIR_ENV]: "-stale" }, projectDirName: "-Users-z-repo" })[PROJECT_DIR_ENV]).toBe("-Users-z-repo");
    // Nobody naming one leaves the CLI keying off the folder each turn runs in.
    expect(PROJECT_DIR_ENV in buildEnv({ base })).toBe(false);
  });

  it("never sets CLAUDE_CONFIG_DIR or IS_SANDBOX of its own: the login environment carries them where they are true", () => {
    // Claude keys its Keychain item by whether the variable is set, so a person's own Mac must see it unset unless
    // their shell sets it; a machine's login carries its own, the sandbox flag with it.
    const own = buildEnv({ base });
    expect(own.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(own.IS_SANDBOX).toBeUndefined();
    expect(own.HOME).toBe("/Users/z");
    const theirs = buildEnv({ base: { ...base, CLAUDE_CONFIG_DIR: "/Users/z/elsewhere" } });
    expect(theirs.CLAUDE_CONFIG_DIR).toBe("/Users/z/elsewhere");
    const guest = buildEnv({ base: { HOME: "/root", CLAUDE_CONFIG_DIR: "/root/.claude-cfg", IS_SANDBOX: "1" } });
    expect(guest.CLAUDE_CONFIG_DIR).toBe("/root/.claude-cfg");
    expect(guest.IS_SANDBOX).toBe("1");
  });

  it("sets the headless flags: IDE-discovery suppression", () => {
    const env = buildEnv({ base });
    expect(env.CLAUDE_CODE_AUTO_CONNECT_IDE).toBe("0");
    expect(env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL).toBe("1");
    const leaked = Object.keys(env).filter(
      (k) =>
        (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") &&
        k !== "CLAUDE_CODE_AUTO_CONNECT_IDE" &&
        k !== "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL",
    );
    expect(leaked).toEqual([]);
  });

  it("passes the API key through when given", () => {
    const env = buildEnv({ base: {}, apiKey: "sk-ant-x" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
  });

  it("sets our own long-lived token after the strip, so an inherited one of the same name never rides along", () => {
    const env = buildEnv({ base: { ...base, CLAUDE_CODE_OAUTH_TOKEN: "inherited" }, oauthToken: "sk-ant-oat01-TESTONLY" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-TESTONLY");
    expect(buildEnv({ base: { ...base, CLAUDE_CODE_OAUTH_TOKEN: "inherited" } }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(buildEnv({ base: {} }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("newSessionId", () => {
  it("returns unique v4-shaped UUIDs", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });
});

describe("buildCommand", () => {
  const sessionId = "e16ed170-8257-4668-879e-fe836341633c";

  it("carries every required flag for a fresh session and reads its messages from stdin as stream-json", () => {
    const cmd = buildCommand({ sessionId });
    expect(cmd).toContain("--output-format stream-json");
    expect(cmd).toContain("--input-format stream-json");
    expect(cmd).toContain("--verbose");
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain(`--session-id ${sessionId}`);
    // stdin is the message channel now: never closed on the command, never a positional prompt
    expect(cmd).not.toContain("</dev/null");
    expect(cmd).toMatch(/claude -p --/);
    expect(cmd).not.toContain("--resume");
  });

  it("uses --resume instead of --session-id when resuming", () => {
    const cmd = buildCommand({ resume: sessionId });
    expect(cmd).toContain(`--resume ${sessionId}`);
    expect(cmd).not.toContain("--session-id");
  });

  it("prefixes cd when a cwd is given", () => {
    const cmd = buildCommand({ sessionId, cwd: "/root/app" });
    expect(cmd.startsWith("cd '/root/app' && claude -p")).toBe(true);
  });

  it("maps the picked model, effort and permission mode to the CLI's flags", () => {
    const cmd = buildCommand({ sessionId, model: "claude-opus-5", effort: "high", permissionMode: "acceptEdits" });
    expect(cmd).toContain("--model 'claude-opus-5'");
    expect(cmd).toContain("--effort 'high'");
    expect(cmd).toContain("--permission-mode 'acceptEdits'");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  it("no permission mode and bypassPermissions both skip permissions, and neither routes prompts here", () => {
    for (const cmd of [buildCommand({ sessionId }), buildCommand({ sessionId, permissionMode: "bypassPermissions" })]) {
      expect(cmd).toContain("--dangerously-skip-permissions");
      expect(cmd).not.toContain("--permission-mode");
      expect(cmd).not.toContain("--permission-prompt-tool");
    }
  });

  it("default names itself and routes its prompts to this host, so the person's own settings do not decide the turn", () => {
    const cmd = buildCommand({ sessionId, permissionMode: "default" });
    expect(cmd).toContain("--permission-mode 'default'");
    expect(cmd).toContain("--permission-prompt-tool stdio");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  it("every mode that can prompt routes its prompts here", () => {
    for (const mode of ["acceptEdits", "plan", "manual", "dontAsk", "auto"]) {
      expect(buildCommand({ sessionId, permissionMode: mode })).toContain("--permission-prompt-tool stdio");
    }
  });

  it("a context window rides the model as the CLI's own suffix; 200k is the plain slug", () => {
    expect(buildCommand({ sessionId, model: "claude-opus-5", contextWindow: "1m" })).toContain("--model 'claude-opus-5[1m]'");
    expect(buildCommand({ sessionId, model: "claude-opus-5", contextWindow: "200k" })).toContain("--model 'claude-opus-5'");
    expect(() => buildCommand({ sessionId, model: "claude-opus-5", contextWindow: "2m" })).toThrow(/contextWindow/);
    expect(() => buildCommand({ sessionId, contextWindow: "1m" })).toThrow(/contextWindow/);
  });

  it("servers handed to a turn ride one --mcp-config as the JSON a config file holds, and the config dir's own are kept", () => {
    const cmd = buildCommand({ sessionId, mcpServers: { wsp: { command: "/usr/local/bin/node", args: ["/opt/wsp/bin.js", "mcp", "--state", "/Users/me/.wsp/state.json"] } } });
    const flag = /--mcp-config '(.+?)' /.exec(cmd)?.[1];
    expect(JSON.parse(flag!)).toEqual({ mcpServers: { wsp: { command: "/usr/local/bin/node", args: ["/opt/wsp/bin.js", "mcp", "--state", "/Users/me/.wsp/state.json"] } } });
    // Strict would drop the servers the person's own config names, which this turn still wants.
    expect(cmd).not.toContain("--strict-mcp-config");
    expect(buildCommand({ sessionId })).not.toContain("--mcp-config");
    expect(buildCommand({ sessionId, mcpServers: {} })).not.toContain("--mcp-config");
  });

  it("sends no model or effort flag when none was picked", () => {
    const cmd = buildCommand({ sessionId });
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--effort");
  });

  it("rejects a picked value that is not a plain slug", () => {
    expect(() => buildCommand({ sessionId, model: "opus; rm -rf /" })).toThrow(/model/);
    expect(() => buildCommand({ sessionId, effort: "" })).toThrow(/effort/);
    expect(() => buildCommand({ sessionId, permissionMode: "plan mode" })).toThrow(/permissionMode/);
    expect(buildCommand({ sessionId, model: "claude-opus-5[1m]" })).toContain("--model 'claude-opus-5[1m]'");
  });

  it("rejects zero or two session identifiers", () => {
    expect(() => buildCommand({})).toThrow(/exactly one/);
    expect(() => buildCommand({ sessionId, resume: sessionId })).toThrow(
      /exactly one/,
    );
  });

  it("rejects a session identifier that is not a UUID", () => {
    expect(() => buildCommand({ resume: "$(rm -rf /)" })).toThrow(/UUID/);
    expect(() => buildCommand({ sessionId: "abc" })).toThrow(/UUID/);
  });
});

describe("userMessageLine", () => {
  const sessionId = "e16ed170-8257-4668-879e-fe836341633c";

  it("is one stream-json user line the CLI takes on stdin, with the text intact", () => {
    const text = "don't run $(reboot) `id`\nsecond line with \"quotes\"";
    const line = userMessageLine(text, sessionId);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
  });

  it("carries an image as a base64 content block ahead of the text, with the type the person's file was", () => {
    const bytes = Buffer.from("not really a png").toString("base64");
    const line = userMessageLine("what does this show?", sessionId, [{ mediaType: "image/png", bytes }]);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: bytes } },
          { type: "text", text: "what does this show?" },
        ],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
  });

  it("carries every image of the message, in the order the person added them, each with its own type", () => {
    const line = userMessageLine("these three", sessionId, [
      { mediaType: "image/png", bytes: "AAA=" },
      { mediaType: "image/jpeg", bytes: "BBB=" },
      { mediaType: "image/webp", bytes: "CCC=" },
    ]);
    const content = (JSON.parse(line) as { message: { content: { type: string; source?: { media_type: string; data: string } }[] } }).message.content;
    expect(content.map(block => block.type)).toEqual(["image", "image", "image", "text"]);
    expect(content.slice(0, 3).map(block => block.source?.media_type)).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(content.slice(0, 3).map(block => block.source?.data)).toEqual(["AAA=", "BBB=", "CCC="]);
  });

  it("a message with no image is the one-block line it always was: nothing rides for free", () => {
    expect(JSON.parse(userMessageLine("plain", sessionId, []))).toEqual(JSON.parse(userMessageLine("plain", sessionId)));
  });
});
