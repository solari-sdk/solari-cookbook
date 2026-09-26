// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { S_RADIO_ACTIVE, S_RADIO_INACTIVE } from "@clack/prompts";
import { exitClassOf, keyRefusedLine, LOOPBACK, savedKeyRefusedLine } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVE_FLAGS, SHARED_FLAGS, cli, forkCommandFor, jsonCliIO, keySources, loadKeys, optsFor, providerBesideRefusal, saveQuestion, terminalIO, upCommandFor, type CliIO, type KeySources, type LoadedKeys, type NoProviderKey } from "../src/cli.js";
import { BOX_API_URL, BoxBackend, type KeyCheck } from "@wsp/engine";
import { keysOf, savedEnv, vaultOf, writeEnvFile } from "../src/env-keys.js";
import { vaultNow } from "../src/cli.js";
import { BOX_KEY_ENV, PROVIDER_ENV, SOLARI_KEY_ENV, providerBackendFor, wiredProviderId } from "../src/providers.js";

/** What a run came away with, in one shape: the agents' keys it holds and the provider key under the variable the
 * row it is wired to reads, which is where every command now takes one from. */
const held = (loaded: LoadedKeys, name: string = SOLARI_KEY_ENV): Record<string, string | undefined> => ({
  ...(loaded.env[name] !== undefined ? { [name]: loaded.env[name] } : {}),
  ...loaded.keys,
});

const loadHeld = async (io: CliIO, sources: KeySources, ask?: { anthropic: boolean; noSolari?: NoProviderKey; checkSaved?: boolean }, name?: string): Promise<Record<string, string | undefined>> =>
  held(await loadKeys(io, sources, ask), name);

const SOLARI = "slr_live_fake_solari_key";

describe("help", () => {
  it("--yes says a browser or device login, or one held in the Keychain, is left to first use, so macOS has nothing to ask and the build waits on nobody", () => {
    setup();
    // The sentence lives on the flag's own row, which is what wsp init --help prints, not on the front page.
    expect(SHARED_FLAGS.find(f => f.name === "yes")!.says).toContain(
      "a login with a browser or device sign-in, or one held in the Keychain, is left to the first time you need it on the workspace unless a saved recipe answered copy, so macOS has nothing to ask either and the build waits on nobody",
    );
  });
});

describe("the wsp up an init names", () => {
  it("carries the serving flags the init was given, resolved and quoted, and none it was not", () => {
    const opts = { port: 4500, wsPort: 4510, named: true, address: LOOPBACK, statePath: "/tmp/wsp test/state.json" };
    expect(upCommandFor(opts, {})).toBe("wsp up");
    expect(upCommandFor(opts, { state: "state.json" })).toBe("wsp up --state '/tmp/wsp test/state.json'");
    // Every value the line hands over is quoted, as the unit spells the same words: a path with a space in it and a
    // port read the same way, and the person pastes the line whole.
    expect(upCommandFor(opts, { port: "4500", "ws-port": "4510" })).toBe("wsp up --port '4500' --ws-port '4510'");
    // The line the init hands over starts the host the init built: a run told which provider to fork on says so
    // again, or the host that line starts picks no provider and forks nothing.
    const named = { ...opts, address: "0.0.0.0", advertise: "http://10.0.0.9:4500", provider: "box", relay: false };
    expect(upCommandFor(named, { provider: "box" })).toBe("wsp up --provider 'box'");
    expect(upCommandFor(named, { listen: "0.0.0.0", advertise: "http://10.0.0.9:4500", "no-relay": true })).toBe("wsp up --listen '0.0.0.0' --advertise 'http://10.0.0.9:4500' --no-relay");
    // Every row of the table, so one added tomorrow is spelled here too rather than dropped from the handover.
    const all = upCommandFor(named, { state: "s", port: "4500", "ws-port": "4510", listen: "0.0.0.0", advertise: "http://10.0.0.9:4500", provider: "box", "no-relay": true });
    for (const flag of SERVE_FLAGS) expect(all, `--${flag.name} in the line an init hands over`).toContain(`--${flag.name}`);
    // The fork runs against the host wsp up started, so it needs the state and not the ports.
    expect(forkCommandFor(opts, {})).toBe("wsp new first");
    expect(forkCommandFor(opts, { state: "state.json" })).toBe("wsp new first --state '/tmp/wsp test/state.json'");
  });
});

describe("--json keeps stdout to the objects", () => {
  it("every line the run says, and every question it cannot ask, goes to the stream beside stdout", async () => {
    const err = new PassThrough();
    const said: string[] = [];
    err.on("data", (c: Buffer) => said.push(c.toString()));
    const io = jsonCliIO(err);
    io.log("app         http://127.0.0.1:4400");
    io.error("reap: sweep failed");
    io.stream?.("half a line");
    // The variable rides with the question, so a line nobody could answer still says what to put in a file.
    await expect(io.askSecret("Solari API key\nNo SOLARI_API_KEY in the environment, ./.env, or the .env beside your state file (~/.wsp/.env unless you named a state).", "SOLARI_API_KEY")).rejects.toThrow(
      "Solari API key: --json asks nothing; set SOLARI_API_KEY in the environment, ./.env, or the .env beside your state file (~/.wsp/.env unless you named a state).",
    );
    // A secret nobody can type is the contract's auth class; a yes-or-no nobody can answer is not.
    await expect(io.askSecret("Solari API key").then(() => "provider", exitClassOf)).resolves.toBe("auth");
    await expect(io.ask("Save the key so wsp stops asking?")).rejects.toThrow("--json asks nothing");
    await expect(io.ask("Save the key so wsp stops asking?").then(() => "ok", exitClassOf)).resolves.toBe("provider");
    expect(said.join("")).toBe("app         http://127.0.0.1:4400\nreap: sweep failed\nhalf a line");
  });

  it("wsp init --yes --json is refused in one line, since --yes skips the sign-ins --json is there to print", async () => {
    const said: string[] = [];
    const io: CliIO = { log: l => said.push(`out ${l}`), error: l => said.push(`err ${l}`), ask: async () => "no", askSecret: async () => "" };
    expect(await cli(["init", "--yes", "--json"], io)).toBe(3);
    // A --json line's refusal is the failure object, the one shape an agent parses on every verb and command.
    expect(said).toEqual([`err ${JSON.stringify({ error: "wsp init: --json prints the sign-ins as they are handed to you, and --yes skips the sign-ins, so there would be nothing to print. Drop one of them.", class: "usage", exit: 3 })}`]);
  });
});

const ANTHROPIC = "sk-ant-x-fake-anthropic-key";

interface FakeIO extends CliIO {
  output: string[];
}

function fakeIO(answers: string[], isTTY = false): FakeIO {
  const queue = [...answers];
  const output: string[] = [];
  const next = (question: string): Promise<string> => {
    output.push(question);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
    return Promise.resolve(answer);
  };
  return {
    output,
    isTTY,
    log: l => output.push(l),
    error: l => output.push(l),
    ask: next,
    askSecret: next,
  };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

let dir: string;
let cwd: string;
let home: string;
/** The state file these runs serve, whose folder is the home above: the .env a host reads its own keys out of
 * sits beside it, which on the default home is the wsp home's own file. */
let state: string;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
function setup(): void {
  dir = mkdtempSync(join(tmpdir(), "wsp-keys-"));
  cwd = join(dir, "cwd");
  home = join(dir, "home");
  state = join(home, "state.json");
  mkdirSync(cwd);
}

describe("a host's own keys, the ones the app's setup reads", () => {
  it("savedEnv reads the .env beside the state file alone: a key in the process environment or a checkout's .env is not saved", () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(cwd, ".env"), "SOLARI_API_KEY=from-cwd\nANTHROPIC_API_KEY=anth-from-cwd\n");
    process.env["ANTHROPIC_API_KEY"] = "anth-from-env";
    try {
      expect(savedEnv(state)).toEqual({});
      expect(keysOf(savedEnv(state))).toEqual({});
      writeFileSync(join(home, ".env"), "SOLARI_API_KEY=from-home\nOPENAI_API_KEY=sk-x-fake\nEMPTY=\n");
      expect(savedEnv(state)).toEqual({ SOLARI_API_KEY: "from-home", OPENAI_API_KEY: "sk-x-fake" });
      // The provider's key is its row's own variable and nothing on the keys a record answers with: those are the
      // agents' alone, and this record holds none.
      expect(keysOf(savedEnv(state))).toEqual({});
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("the vault a turn launches with is the file beside this host's state alone: a key in this shell or in a folder's .env is not in it", () => {
    setup();
    mkdirSync(home);
    // Both of the other places a key is read from on this computer, and neither is the vault: a host serving under
    // launchd starts without this shell, and a .env beside whatever folder a host was started in is nobody's vault.
    writeFileSync(join(cwd, ".env"), `ANTHROPIC_API_KEY=anth-from-cwd\n`);
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-TESTONLYfromtheshell";
    const here = process.cwd();
    process.chdir(cwd);
    try {
      expect(vaultNow(state)).toEqual({});
      writeFileSync(join(home, ".env"), `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-TESTONLYfromthefile\nSOLARI_API_KEY=${SOLARI}\n`);
      expect(vaultNow(state)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-TESTONLYfromthefile" });
      // The servers' values beside it come whole, under the names their definitions on other computers read; a
      // row's own variable there never outranks the row's.
      writeFileSync(join(home, "servers.env"), "WSP_MCP_CONTEXT7_AUTHORIZATION=c7_TESTONLY\nnotion_token=ntn_TESTONLY\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-TESTONLYstale\n");
      expect(vaultNow(state)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-TESTONLYfromthefile", WSP_MCP_CONTEXT7_AUTHORIZATION: "c7_TESTONLY", notion_token: "ntn_TESTONLY" });
      writeFileSync(join(home, ".env"), `SOLARI_API_KEY=${SOLARI}\n`);
      expect(vaultNow(state)).toEqual({ WSP_MCP_CONTEXT7_AUTHORIZATION: "c7_TESTONLY", notion_token: "ntn_TESTONLY" });
    } finally {
      process.chdir(here);
      delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    }
  });

  it("the vault is cut to the variables the catalog declares, empty values dropped, and the provider's key is not among them", () => {
    expect(vaultOf({ SOLARI_API_KEY: SOLARI, OPENAI_API_KEY: "sk-x-fake", OTHER: "x", GEMINI_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-TESTONLY", ANTHROPIC_API_KEY: ANTHROPIC })).toEqual({
      OPENAI_API_KEY: "sk-x-fake",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-TESTONLY",
      ANTHROPIC_API_KEY: ANTHROPIC,
    });
    expect(vaultOf({})).toEqual({});
  });
});

describe("the environment every verb is handed", () => {
  /** A state file in a folder of its own, with the wsp home holding a key and a pick beside a state file this run
   * does not serve. */
  function elsewhere(): { state: string; back: string } {
    setup();
    mkdirSync(home);
    const folder = join(dir, "elsewhere");
    mkdirSync(folder);
    writeFileSync(join(home, ".env"), `SOLARI_API_KEY=${SOLARI}\nWSP_PROVIDER=box\n`);
    const back = process.cwd();
    process.chdir(folder);
    return { state: join(folder, "state.json"), back };
  }

  it("reads its key and its pick from the .env beside the state it names, and the wsp home's from nowhere else", () => {
    const { state, back } = elsewhere();
    try {
      const opts = optsFor({ state }, { WSP_HOME: home });
      // The file the live home holds is another host's: this one carries no key and no pick, so it is wired to the
      // row that holds no machine and puts nothing to any provider.
      expect(opts.providerEnv[SOLARI_KEY_ENV]).toBeUndefined();
      expect(opts.providerEnv[PROVIDER_ENV]).toBeUndefined();
      expect(wiredProviderId(opts.providerEnv)).toBe("none");
      // The same run on the home's own state file reads that file, which is where wsp init wrote both.
      const own = optsFor({ state: join(home, "state.json") }, { WSP_HOME: home });
      expect(own.providerEnv[SOLARI_KEY_ENV]).toBe(SOLARI);
      expect(wiredProviderId(own.providerEnv)).toBe("box");
    } finally {
      process.chdir(back);
    }
  });

  it("keeps the shell in front of the file: a key or a pick the person exported is this run's", () => {
    const { state, back } = elsewhere();
    try {
      const shell = optsFor({ state }, { WSP_HOME: home, SOLARI_API_KEY: "from-env" });
      expect(shell.providerEnv[SOLARI_KEY_ENV]).toBe("from-env");
      expect(wiredProviderId(shell.providerEnv)).toBe("solari");
      // And the word on the line stands in front of both.
      expect(optsFor({ state, provider: "box" }, { WSP_HOME: home, SOLARI_API_KEY: "from-env" }).providerEnv[PROVIDER_ENV]).toBe("box");
    } finally {
      process.chdir(back);
    }
  });
});

describe("the one writer of a host's own .env", () => {
  it("refuses a value that would write a second variable line, and leaves the file as it stood", () => {
    setup();
    mkdirSync(home);
    const envPath = join(home, ".env");
    writeFileSync(envPath, "OTHER=keep me\n");
    for (const carried of ["sk-ant-x-one\nANTHROPIC_API_KEY=sk-ant-x-two", "sk-ant-x-one\rANTHROPIC_API_KEY=sk-ant-x-two"]) {
      expect(() => writeEnvFile(envPath, { ANTHROPIC_API_KEY: carried })).toThrow("the value for ANTHROPIC_API_KEY carries a line break, and one variable is one line");
    }
    expect(readFileSync(envPath, "utf8")).toBe("OTHER=keep me\n");

    // A value with no break in it is written as it always was.
    writeEnvFile(envPath, { ANTHROPIC_API_KEY: "sk-ant-x-fine" });
    expect(readFileSync(envPath, "utf8").split("\n")).toEqual(expect.arrayContaining(["OTHER=keep me", "ANTHROPIC_API_KEY=sk-ant-x-fine"]));
  });
});

describe("loadKeys", () => {
  it("prompts for both keys and persists them to <home>/.env with mode 600", async () => {
    setup();
    const io = fakeIO([SOLARI, ANTHROPIC, "yes"]);
    expect(await loadHeld(io, { env: {}, cwd, statePath: state })).toEqual({ SOLARI_API_KEY: SOLARI, anthropic: ANTHROPIC });
    const envPath = join(home, ".env");
    expect(mode(envPath)).toBe(0o600);
    expect(readFileSync(envPath, "utf8").split("\n")).toEqual(
      expect.arrayContaining([`SOLARI_API_KEY=${SOLARI}`, `ANTHROPIC_API_KEY=${ANTHROPIC}`]),
    );
    // Prompt strings, log lines, and questions never carry key material.
    expect(io.output.join("\n")).not.toContain(SOLARI);
    expect(io.output.join("\n")).not.toContain(ANTHROPIC);
  });

  it("says no key was found, where to get one, and names the file only because this home is not the default", async () => {
    setup();
    const io = fakeIO([SOLARI, ANTHROPIC, "yes"]);
    await loadKeys(io, { env: {}, cwd, statePath: state });
    const [key, anthropic, save] = io.output.map(stripVTControlCharacters);
    expect(key).toBe("Solari API key\nNo SOLARI_API_KEY in the environment, ./.env, or the .env beside your state file (~/.wsp/.env unless you named a state).\nconsole.getsolari.com");
    expect(anthropic).toMatch(/^Anthropic API key\noptional, enter skips\n/);
    expect(save).toBe(`Save the keys to ${join(home, ".env")} so wsp stops asking?`);
    expect(io.output.join("\n")).not.toMatch(/—|!/);
  });

  it("rewrites an existing 644 file down to 600 and keeps lines it did not set", async () => {
    setup();
    mkdirSync(home);
    const envPath = join(home, ".env");
    writeFileSync(envPath, "OTHER=keep me\n# a comment\n");
    chmodSync(envPath, 0o644);
    expect(mode(envPath)).toBe(0o644);

    await loadKeys(fakeIO([SOLARI, "", "yes"]), { env: {}, cwd, statePath: state });

    expect(mode(envPath)).toBe(0o600);
    const lines = readFileSync(envPath, "utf8").split("\n");
    expect(lines).toContain("OTHER=keep me");
    expect(lines).toContain("# a comment");
    expect(lines).toContain(`SOLARI_API_KEY=${SOLARI}`);
  });

  it("resolves each key on its own: env, then ./.env, then the .env beside the state file", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(cwd, ".env"), "SOLARI_API_KEY=from-cwd\nANTHROPIC_API_KEY=anth-from-cwd\n");
    writeFileSync(join(home, ".env"), "SOLARI_API_KEY=from-home\nANTHROPIC_API_KEY=anth-from-home\n");

    const io = fakeIO([]);
    expect(await loadHeld(io, { env: { SOLARI_API_KEY: "from-env" }, cwd, statePath: state })).toEqual({
      SOLARI_API_KEY: "from-env",
      anthropic: "anth-from-cwd",
    });
    expect(io.output).toEqual([]);

    writeFileSync(join(cwd, ".env"), "SOLARI_API_KEY=from-cwd\n");
    expect(await loadHeld(fakeIO([]), { env: {}, cwd, statePath: state })).toEqual({
      SOLARI_API_KEY: "from-cwd",
      anthropic: "anth-from-home",
    });

    rmSync(join(cwd, ".env"));
    expect(await loadHeld(fakeIO([]), { env: {}, cwd, statePath: state })).toEqual({
      SOLARI_API_KEY: "from-home",
      anthropic: "anth-from-home",
    });
  });

  it("enter skips the Anthropic key, the save question says key not keys, and the saved file has no ANTHROPIC line", async () => {
    setup();
    const io = fakeIO([SOLARI, "", "yes"]);
    expect(await loadHeld(io, { env: {}, cwd, statePath: state })).toEqual({ SOLARI_API_KEY: SOLARI });
    expect(io.output[2]).toMatch(/^Save the key to /);
    const text = readFileSync(join(home, ".env"), "utf8");
    expect(text).not.toContain("ANTHROPIC");
    expect(text).toContain(`SOLARI_API_KEY=${SOLARI}`);
  });

  it("does not persist by default (no means no)", async () => {
    setup();
    const io = fakeIO([SOLARI, ANTHROPIC, "no"]);
    expect(await loadHeld(io, { env: {}, cwd, statePath: state })).toEqual({ SOLARI_API_KEY: SOLARI, anthropic: ANTHROPIC });
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(io.output.join("\n")).not.toContain(SOLARI);
    expect(io.output.join("\n")).not.toContain(ANTHROPIC);
  });

  it("mentions subscriptions in the Anthropic prompt but never in the provider's one", async () => {
    setup();
    const io = fakeIO([SOLARI, "", "no"]);
    await loadKeys(io, { env: {}, cwd, statePath: state });
    expect(io.output[0]).not.toContain("/login");
    expect(io.output[1]).toContain("/login");
    expect(io.output.join("\n")).not.toContain("—");
  });

  it("puts a typed key to the provider before it writes it: a refused key is not saved and is asked for again in the provider's own words", async () => {
    setup();
    const asked: string[] = [];
    const io = fakeIO(["slr_live_wrong", "slr_live_right", "yes"], true);
    const keys = await loadHeld(io, { env: {}, cwd, statePath: state, checkKey: key => (asked.push(key), Promise.resolve(key === "slr_live_right" ? { state: "taken" } : { state: "refused", said: "401 Unauthorized" })) }, { anthropic: false });
    expect(asked).toEqual(["slr_live_wrong", "slr_live_right"]);
    expect(keys).toEqual({ SOLARI_API_KEY: "slr_live_right" });
    // The second question carries the provider's own words, which is what the app's field says too.
    expect(stripVTControlCharacters(io.output[1]!)).toContain(keyRefusedLine("401 Unauthorized", "solari"));
    // Only the key the provider took reached the file, and no question ever carried either key.
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("SOLARI_API_KEY=slr_live_right");
    expect(readFileSync(join(home, ".env"), "utf8")).not.toContain("slr_live_wrong");
    expect(io.output.join("\n")).not.toContain("slr_live_");
  });

  it("stops asking after three refused keys, with the provider's word as the reason", async () => {
    setup();
    const io = fakeIO(["slr_live_a", "slr_live_b", "slr_live_c", "yes"], true);
    const sources = { env: {}, cwd, statePath: state, checkKey: async () => ({ state: "refused" as const, said: "401 Unauthorized" }) };
    await expect(loadKeys(io, sources, { anthropic: false })).rejects.toThrow(keyRefusedLine("401 Unauthorized", "solari"));
    expect(io.output).toHaveLength(3);
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("a check nothing answered takes the typed key: a road that is down is not the key's fault", async () => {
    setup();
    const io = fakeIO(["slr_live_maybe", "yes"], true);
    const keys = await loadHeld(io, { env: {}, cwd, statePath: state, checkKey: async () => ({ state: "unchecked", said: "fetch failed" }) }, { anthropic: false });
    expect(keys).toEqual({ SOLARI_API_KEY: "slr_live_maybe" });
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("SOLARI_API_KEY=slr_live_maybe");
  });

  it("the build's own road checks the saved key and asks for another one on this run; every other verb takes it as it stands", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(home, ".env"), `SOLARI_API_KEY=${SOLARI}\n`);
    const checked: string[] = [];
    const checkKey = (key: string): Promise<KeyCheck> => (checked.push(key), Promise.resolve(key === SOLARI ? { state: "refused", said: "401 Unauthorized" } : { state: "taken" }));
    // wsp init, the road that is about to build with it.
    const io = fakeIO(["slr_live_new", "yes"], true);
    expect(await loadHeld(io, { env: {}, cwd, statePath: state, checkKey }, { anthropic: false, noSolari: "offer", checkSaved: true })).toEqual({ SOLARI_API_KEY: "slr_live_new" });
    expect(checked).toEqual([SOLARI, "slr_live_new"]);
    expect(stripVTControlCharacters(io.output[0]!)).toContain(savedKeyRefusedLine("401 Unauthorized", "solari"));
  });

  it("a saved Box key the provider refused is said as Box's refusal, not Solari's", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(home, ".env"), `WSP_PROVIDER=box\nBOX_API_KEY=box_live_x\n`);
    const sources = { env: {}, cwd, statePath: state, checkKey: async () => ({ state: "refused" as const, said: "401 Unauthorized" }) };
    await expect(loadKeys(fakeIO([]), sources, { anthropic: false, noSolari: "offer", checkSaved: true })).rejects.toThrow("Box by ASCII refused the saved key: 401 Unauthorized");
  });

  it("every other verb takes the saved key as it stands: nothing is asked of the provider and nothing of the person", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(home, ".env"), `SOLARI_API_KEY=${SOLARI}\n`);
    const checked: string[] = [];
    const sources = { env: {}, cwd, statePath: state, checkKey: (key: string): Promise<KeyCheck> => (checked.push(key), Promise.resolve({ state: "refused" as const, said: "401 Unauthorized" })) };
    for (const noSolari of ["local", "offer", undefined] as const) {
      const quiet = fakeIO([], true);
      expect(await loadHeld(quiet, sources, { anthropic: false, ...(noSolari !== undefined ? { noSolari } : {}) })).toEqual({ SOLARI_API_KEY: SOLARI });
      expect(quiet.output).toEqual([]);
    }
    expect(checked).toEqual([]);
  });

  it("a saved key the provider refused is never quietly dropped for the local road off a terminal", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(home, ".env"), `SOLARI_API_KEY=${SOLARI}\n`);
    const sources = { env: {}, cwd, statePath: state, checkKey: async () => ({ state: "refused" as const, said: "401 Unauthorized" }) };
    await expect(loadKeys(fakeIO([]), sources, { anthropic: false, noSolari: "offer", checkSaved: true })).rejects.toThrow(savedKeyRefusedLine("401 Unauthorized", "solari"));
  });

  it("refuses to start on an empty provider key without leaking anything", async () => {
    setup();
    await expect(loadKeys(fakeIO(["   "]), { env: {}, cwd, statePath: state })).rejects.toThrow(/SOLARI_API_KEY/);
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("init offers the key at a terminal, and an empty answer is the answer: no provider key, and the question said so", async () => {
    setup();
    const io = fakeIO([""], true);
    expect(await loadHeld(io, { env: {}, cwd, statePath: state }, { anthropic: false, noSolari: "offer" })).toEqual({});
    expect(stripVTControlCharacters(io.output[0]!)).toBe(
      "Solari API key\nNo SOLARI_API_KEY in the environment, ./.env, or the .env beside your state file (~/.wsp/.env unless you named a state).\nconsole.getsolari.com\nEnter with nothing skips the cloud: this computer alone becomes your workspace, and nothing is sealed.",
    );
    // Nothing is written: there is no key to save.
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("init with nobody at a keyboard asks nothing at all", async () => {
    setup();
    const io = fakeIO([]);
    expect(await loadHeld(io, { env: {}, cwd, statePath: state }, { anthropic: false, noSolari: "offer" })).toEqual({});
    expect(io.output).toEqual([]);
  });

  it("the local road asks nothing even at a terminal: init already answered, and up, new --local and doctor --local seal nothing to skip", async () => {
    setup();
    const io = fakeIO([], true);
    expect(await loadHeld(io, { env: { ANTHROPIC_API_KEY: ANTHROPIC }, cwd, statePath: state }, { anthropic: false, noSolari: "local" })).toEqual({ anthropic: ANTHROPIC });
    expect(io.output).toEqual([]);
  });

  it("the Claude key rides the local road: it is the agents' key, not the provider's, and a thread here uses it", async () => {
    setup();
    const io = fakeIO([""], true);
    expect(await loadHeld(io, { env: { ANTHROPIC_API_KEY: ANTHROPIC }, cwd, statePath: state }, { anthropic: false, noSolari: "offer" })).toEqual({ anthropic: ANTHROPIC });
  });

  it("the local road is the caller's to ask for: every other command still refuses an empty answer", async () => {
    setup();
    await expect(loadKeys(fakeIO([""], true), { env: {}, cwd, statePath: state }, { anthropic: false }).then(() => "ok", exitClassOf)).resolves.toBe("auth");
  });

  it("a key that is there answers the local road too, with nothing asked", async () => {
    setup();
    const io = fakeIO([]);
    expect(await loadHeld(io, { env: { SOLARI_API_KEY: SOLARI }, cwd, statePath: state }, { anthropic: false, noSolari: "local" })).toEqual({ SOLARI_API_KEY: SOLARI });
    expect(io.output).toEqual([]);
  });

  it("the flags about a golden are refused on the local road rather than taken and ignored", async () => {
    setup();
    // Pinned off this computer's key layers: a Solari key on the Mac running the suite would make this a real init that boots a machine.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("WSP_HOME", home);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const io = fakeIO([]);
    for (const flag of [["--no-local"], ["--first-workspace", "proj"], ["--import", cwd], ["--recipe", "r.json"], ["--project", cwd], ["--on", "spoo"], ["--rebuild"]]) {
      const code = await cli(["init", "--state", join(home, "state.json"), ...flag], io);
      expect([flag.join(" "), code]).toEqual([flag.join(" "), 3]);
    }
    expect(io.output.join("\n")).toContain("--no-local would leave it with nothing");
    expect(io.output.join("\n")).toContain("--first-workspace would do nothing here");
    expect(io.output.join("\n")).toContain("--import would do nothing here");
    expect(io.output.join("\n")).toContain("--rebuild would do nothing here");
    // A place is the serving host's to know; with none serving the flag names nothing this run can reach.
    expect(io.output.join("\n")).toContain("--on names a place of the host serving");
  });

  it("the save question names the file only when WSP_HOME is not the default", () => {
    expect(saveQuestion(join(homedir(), ".wsp"), 1)).toBe("Save the key so wsp stops asking?");
    expect(saveQuestion(join(homedir(), ".wsp"), 2)).toBe("Save the keys so wsp stops asking?");
    expect(saveQuestion("/srv/wsp", 1)).toBe("Save the key to /srv/wsp/.env so wsp stops asking?");
  });
});


describe("the key a run is asked for is the one its own provider reads", () => {
  const box = { WSP_PROVIDER: "box" };
  const quiet = { anthropic: false, noSolari: "local" as const };

  it("reads a registered row's key from each of the three layers, under the variable that row declares", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(home, ".env"), `${BOX_KEY_ENV}=from-home\n`);
    expect(await loadHeld(fakeIO([]), { env: box, cwd, statePath: state }, quiet, BOX_KEY_ENV)).toEqual({ [BOX_KEY_ENV]: "from-home" });
    writeFileSync(join(cwd, ".env"), `${BOX_KEY_ENV}=from-cwd\n`);
    expect(await loadHeld(fakeIO([]), { env: box, cwd, statePath: state }, quiet, BOX_KEY_ENV)).toEqual({ [BOX_KEY_ENV]: "from-cwd" });
    expect(await loadHeld(fakeIO([]), { env: { ...box, [BOX_KEY_ENV]: "from-env" }, cwd, statePath: state }, quiet, BOX_KEY_ENV)).toEqual({ [BOX_KEY_ENV]: "from-env" });
    // The module a run builds is picked out of that same environment, so the key the layers held is the one the
    // backend forks with: this is what `wsp up --service` on a box with the key in a file had no road to before.
    const { env } = await loadKeys(fakeIO([]), { env: box, cwd, statePath: state }, quiet);
    expect(providerBackendFor(env)).toBeInstanceOf(BoxBackend);
    expect(env[BOX_KEY_ENV]).toBe("from-cwd");
  });

  it("names the wired provider's variable on the key screen and never another provider's", async () => {
    setup();
    const asked = fakeIO([""], true);
    expect(await loadHeld(asked, { env: box, cwd, statePath: state }, { anthropic: false, noSolari: "offer" }, BOX_KEY_ENV)).toEqual({});
    const screen = stripVTControlCharacters(asked.output[0]!);
    // The title is the row's own words for its key, and the variable is said once, where the line says where to put
    // it so this screen is not drawn again.
    expect(screen.split("\n")[0]).toBe("Box API key");
    expect(screen.match(new RegExp(BOX_KEY_ENV, "g"))).toHaveLength(1);
    expect(screen).toContain(`No ${BOX_KEY_ENV} in the environment, ./.env, or the .env beside your state file (~/.wsp/.env unless you named a state).`);
    expect(screen.toLowerCase()).not.toContain("solari");
    // With no provider named, the cloud a key alone wires is the one offered, by its own variable.
    const plain = fakeIO([""], true);
    await loadKeys(plain, { env: {}, cwd, statePath: state }, { anthropic: false, noSolari: "offer" });
    expect(stripVTControlCharacters(plain.output[0]!)).toContain(SOLARI_KEY_ENV);
    expect(stripVTControlCharacters(plain.output[0]!)).not.toContain(BOX_KEY_ENV);
    // A provider that reads no key is asked for none: there is no screen to open.
    const keyless = fakeIO([], true);
    expect(await loadHeld(keyless, { env: { WSP_PROVIDER: "fake" }, cwd, statePath: state }, { anthropic: false, noSolari: "offer" })).toEqual({});
    expect(keyless.output).toEqual([]);
  });

  it("a provider named beside a serving host is refused where that host forks elsewhere, and taken in silence where it does not", () => {
    setup();
    // The build beside a serving host runs in that host's own init job, on the provider that host started on: the
    // word on this line reaches no runtime of this run's, so it is refused rather than dropped.
    const lock = { pid: 4242, port: 3000, wsPort: 3001, startedAt: "2026-09-22T00:00:00.000Z" };
    const asked = (values: { provider?: string }, env: Record<string, string> = {}): string | undefined => {
      const opts = optsFor({ ...values, state }, { ...env, WSP_HOME: home });
      return providerBesideRefusal(lock, opts, "solari", upCommandFor(opts, { ...values, state }))?.message;
    };
    // The way back is the line this run composes for every other handover, so it carries the --state this init was
    // given: following it serves the state file the sentence names and not this computer's default one.
    expect(asked({ provider: "box" })).toBe(`wsp init: the wsp host serving ${state} (pid 4242) runs this build and forks on solari, not box. Drop --provider, or take that host down and start it again with wsp up --state '${state}' --provider 'box'.`);
    // The provider that host already forks on is the build that was asked for, so there is nothing to say.
    expect(asked({ provider: "solari" })).toBeUndefined();
    expect(asked({})).toBeUndefined();
    // The word its machines wear is what is compared: a stand-in serving in place of that cloud is that cloud.
    expect(asked({ provider: "fake" }, { WSP_FAKE_AS: "solari" })).toBeUndefined();
    expect(asked({ provider: "fake" })).toBe(`wsp init: the wsp host serving ${state} (pid 4242) runs this build and forks on solari, not fake. Drop --provider, or take that host down and start it again with wsp up --state '${state}' --provider 'fake'.`);
    // A host that does not say where it forks is a host of an earlier build: nothing to compare and nothing said.
    const quiet = optsFor({ provider: "box", state }, { WSP_HOME: home });
    expect(providerBesideRefusal(lock, quiet, undefined, upCommandFor(quiet, { provider: "box", state }))).toBeUndefined();
  });

  it("puts a typed key to the picked provider's own probe, with that provider's own key header", async () => {
    setup();
    const called: { url: string; auth: unknown }[] = [];
    vi.stubGlobal("fetch", (url: string | URL, init?: { headers?: Record<string, string> }) => {
      called.push({ url: String(url), auth: init?.headers?.["Authorization"] });
      return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    });
    await keySources(box, state).checkKey!("box_fake_key");
    await keySources({}, state).checkKey!("slr_live_fake_key");
    expect(called).toEqual([
      { url: `${BOX_API_URL}/limits`, auth: "Bearer box_fake_key" },
      { url: "https://api.getsolari.com/templates", auth: "Bearer slr_live_fake_key" },
    ]);
  });
});

interface Screen {
  io: CliIO;
  input: PassThrough;
  text(): string;
  type(keys: string): Promise<void>;
}

function screen(tty: boolean): Screen {
  const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode: () => input });
  const output = Object.assign(new PassThrough(), { isTTY: tty, columns: 160 });
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  return {
    io: terminalIO(input, output),
    input,
    text: () => stripVTControlCharacters(chunks.join("")),
    type: async keys => {
      await new Promise(r => setTimeout(r, 20));
      input.write(keys);
      await new Promise(r => setTimeout(r, 20));
    },
  };
}

describe("terminalIO", () => {
  it("on a terminal the key is a masked prompt with its hint lines under the question, and the save is a confirm that defaults to No", async () => {
    setup();
    const s = screen(true);
    const run = loadKeys(s.io, { env: {}, cwd, statePath: state }, { anthropic: false });
    await s.type(`${SOLARI}\r`);
    await s.type("\r");
    expect(held(await run)).toEqual({ SOLARI_API_KEY: SOLARI });
    const out = s.text();
    // The hint wraps at the frame's width, so the tail of the file's words may land under the bar.
    expect(out).toContain("◆  Solari API key\n┃  No SOLARI_API_KEY in the environment, ./.env, or the .env beside your state file (~/.wsp/.env");
    expect(out).toMatch(/┃  console\.getsolari\.com\n┃  _\n┗  enter next • esc cancel/);
    // The question is wrapped at the frame's width, so the path may push "so wsp stops asking?" under the bar.
    expect(out).toContain(`◆  Save the key to ${join(home, ".env")} so wsp`);
    expect(out).toMatch(/◆  Save the key to [^\n]*\n(┃    [^\n]*\n)?┃  ○ Yes \/ ● No\n┗  ← → change • y n answer • enter choose • esc cancel/);
    expect(out).toMatch(/◇  Save the key to [^\n]*\n(│    [^\n]*\n)?│  No\n/);
    expect(out).not.toContain(SOLARI);
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("yes at the confirm writes <home>/.env at mode 600", async () => {
    setup();
    const s = screen(true);
    const run = loadKeys(s.io, { env: {}, cwd, statePath: state }, { anthropic: false });
    await s.type(`${SOLARI}\r`);
    await s.type("y");
    expect(held(await run)).toEqual({ SOLARI_API_KEY: SOLARI });
    expect(mode(join(home, ".env"))).toBe(0o600);
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(`SOLARI_API_KEY=${SOLARI}\n`);
    expect(s.text()).not.toContain(SOLARI);
  });

  it("the quiet lines a turn streams are plain when stderr is no terminal and dim when the environment forces colour", () => {
    setup();
    const io = screen(false).io;
    expect(io.muted?.("$ git status")).toBe("$ git status");
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    try {
      expect(io.muted?.("$ git status")).toBe("\x1b[2m$ git status\x1b[22m");
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
  });

  it("ctrl-c at the key prompt stops with nothing written", async () => {
    setup();
    const s = screen(true);
    const stopped = expect(loadKeys(s.io, { env: {}, cwd, statePath: state })).rejects.toThrow("Nothing was changed.");
    await s.type("\x03");
    await stopped;
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("off a terminal there is nobody to ask: a plain error names the key and where it is read from, and nothing is drawn", async () => {
    setup();
    const s = screen(false);
    await expect(loadKeys(s.io, { env: {}, cwd, statePath: state })).rejects.toThrow(
      "Solari API key: no terminal to ask on; set SOLARI_API_KEY in the environment, ./.env, or the .env beside your state file (~/.wsp/.env unless you named a state).",
    );
    // The variable is the wired provider's own, so a run under a service says what to put in a file rather than
    // leaving a reader of that log to guess which key the words are about.
    await expect(loadKeys(screen(false).io, { env: { WSP_PROVIDER: "box" }, cwd, statePath: state })).rejects.toThrow(
      `Box API key: no terminal to ask on; set ${BOX_KEY_ENV} in the environment, ./.env, or the .env beside your state file (~/.wsp/.env unless you named a state).`,
    );
    await expect(loadKeys(s.io, { env: {}, cwd, statePath: state }).then(() => "ok", exitClassOf)).resolves.toBe("auth");
    await expect(s.io.ask("Save the key so wsp stops asking?").then(() => "ok", exitClassOf)).resolves.toBe("provider");
    expect(s.text()).toBe("");
  });
});
