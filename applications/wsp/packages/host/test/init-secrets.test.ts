// SPDX-License-Identifier: AGPL-3.0-only
// The secrets step over a fake terminal and a scripted daemon link: the
// machine's secrets file is read first so a name already there is not asked
// again; a pasted value reaches the builder in the pty's environment and lands
// in the profile.d file, and in fish's conf.d too when fish is installed; an
// empty answer or an escape skips the name; off a terminal every name is
// skipped with the reason.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { FISH_FILE, SH_FILE, appendCommand, exportLine, fishLine, readCommand, secretsStage, type SecretOutcome } from "../src/init-secrets.js";
import { fakePtyLink, type FakePtyLink, type FakePty } from "./fake-pty-link.js";

const KEY = { enter: "\r", esc: "\x1b" };
const SECRET = "pa'ss word";

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const raw = () => chunks.join("");
  const text = () => stripVTControlCharacters(raw());
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      input.write(k);
      await new Promise(r => setTimeout(r, k === KEY.esc ? 70 : 5));
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
  return { input, output, raw, text, press, until };
}

/** The machine as the step reads it: the names in its secrets file and whether fish is installed. The read answers
 * the way a shell would: the names one per line, the fish mark only when fish is there, and the status of the
 * command's last word (an `if` ends 0 either way; a bare `&& echo` ends 1 without fish). Every append answers
 * with the exit picked; an unreadable machine answers the read with exit 2 and nothing else. */
function scripted(machine: { present?: string[]; fish?: boolean; exit?: number; unreadable?: boolean } = {}): FakePtyLink {
  const link = fakePtyLink();
  link.script = (pty, line) => {
    if (!line.includes("WSP_STATUS")) return;
    if (line.startsWith(readCommand())) {
      if (machine.unreadable) {
        link.data(pty, "WSP_STATUS 2\r\n");
        link.exit(pty, 2);
        return;
      }
      const probe = readCommand().slice(readCommand().indexOf("command -v fish"));
      const status = probe.startsWith("command -v fish") && !probe.includes("; fi") && !probe.endsWith("true") ? (machine.fish ? 0 : 1) : 0;
      link.data(pty, `${(machine.present ?? []).map(n => `${n}\r\n`).join("")}${machine.fish ? "WSP_FISH\r\n" : ""}WSP_STATUS ${status}\r\n`);
      link.exit(pty, status);
      return;
    }
    link.data(pty, `WSP_STATUS ${machine.exit ?? 0}\r\n`);
    link.exit(pty, machine.exit ?? 0);
  };
  return link;
}

const writes = (link: FakePtyLink): FakePty[] => link.ptys.filter(p => !p.ran!.startsWith(readCommand()));

function stage(link: FakePtyLink, t: ReturnType<typeof terminal>, over: { asks?: { name: string; from: string }[]; skipWhy?: string } = {}) {
  const hidden: string[] = [];
  const run = secretsStage({
    asks: over.asks ?? [
      { name: "A_KEY", from: "cut from ~/.zshrc" },
      { name: "B_TOKEN", from: "cut from ~/.zshrc" },
    ],
    dial: async () => ({ link: link.dial(), close: () => {} }),
    input: t.input,
    output: t.output,
    ...(over.skipWhy !== undefined ? { skipWhy: over.skipWhy } : {}),
    hide: v => hidden.push(v),
  });
  return { run, hidden };
}

describe("the lines and the commands", () => {
  it("quotes the value for sh and for fish so it lands byte for byte", () => {
    expect(exportLine("A_KEY", SECRET)).toBe(`export A_KEY='pa'\\''ss word'`);
    expect(fishLine("A_KEY", `it's \\ here`)).toBe(`set -gx A_KEY 'it\\'s \\\\ here'`);
  });

  it("reads the names in the secrets file, never the values, and whether fish is there, ending 0 either way; the append names the environment, never a value, and writes both files only with fish", () => {
    expect(readCommand()).toBe(`sed -n 's/^export \\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' ${SH_FILE} 2>/dev/null; if command -v fish >/dev/null 2>&1; then echo WSP_FISH; fi`);
    expect(appendCommand(false)).toBe(`umask 077; printf '%s\\n' "$WSP_SECRET_LINE" >> ${SH_FILE} && chmod 600 ${SH_FILE}`);
    expect(appendCommand(true)).toBe(`umask 077; printf '%s\\n' "$WSP_SECRET_LINE" >> ${SH_FILE} && chmod 600 ${SH_FILE} && mkdir -p /etc/fish/conf.d && printf '%s\\n' "$WSP_FISH_LINE" >> ${FISH_FILE} && chmod 600 ${FISH_FILE}`);
  });
});

describe("the secrets step", () => {
  it("one variable is asked for once however many rows want it, and the question names every reason", async () => {
    const link = scripted();
    const t = terminal();
    // The rc file exported the key and the sign-ins screen chose an API key for the same variable.
    const { run } = stage(link, t, {
      asks: [
        { name: "ANTHROPIC_API_KEY", from: "cut from ~/.zshrc" },
        { name: "ANTHROPIC_API_KEY", from: "the key Claude Code reads on the machine" },
      ],
    });
    await t.until("ANTHROPIC_API_KEY");
    expect(t.text()).toContain("cut from ~/.zshrc; the key Claude Code reads on the machine");
    await t.press(...SECRET.split(""), KEY.enter);
    const outcomes = await run;
    expect(outcomes).toEqual<SecretOutcome[]>([{ name: "ANTHROPIC_API_KEY", from: "cut from ~/.zshrc; the key Claude Code reads on the machine", state: "set" }]);
    // One read of the machine and one write: the second row never asked and never appended.
    expect(link.ptys).toHaveLength(2);
    expect(t.text().match(/◆  ANTHROPIC_API_KEY/g)).toHaveLength(1);
  });

  it("a pasted value travels in the pty's environment, never on the command line or the screen, and lands in profile.d; an empty answer skips", async () => {
    const link = scripted();
    const t = terminal();
    const { run, hidden } = stage(link, t);
    await t.until("A_KEY");
    expect(t.text()).toContain("cut from ~/.zshrc");
    await t.press(...SECRET.split(""), KEY.enter);
    await t.until(`A_KEY: set in ${SH_FILE} on the machine`);
    await t.until("B_TOKEN");
    await t.press(KEY.enter);
    const outcomes = await run;
    expect(outcomes).toEqual<SecretOutcome[]>([
      { name: "A_KEY", from: "cut from ~/.zshrc", state: "set" },
      { name: "B_TOKEN", from: "cut from ~/.zshrc", state: "skipped", note: "skipped by you" },
    ]);
    // One read of the machine, then one write.
    expect(link.ptys).toHaveLength(2);
    expect(link.ptys[0]!.ran).toBe(readCommand());
    expect(link.ptys[0]!.created["env"]).toEqual({ PS1: "" });
    const pty = writes(link)[0]!;
    expect(pty.created["env"]).toEqual({ PS1: "", WSP_SECRET_LINE: `export A_KEY='pa'\\''ss word'` });
    expect(pty.ran).toBe(appendCommand(false));
    expect(link.ptys.every(p => p.killed)).toBe(true);
    expect(link.dials).toBe(2);
    expect(t.raw()).not.toContain(SECRET);
    expect(t.raw()).not.toContain("ss word");
    expect(hidden).toEqual([SECRET]);
    expect(t.text()).toContain("B_TOKEN: skipped");
    expect(t.text()).not.toMatch(/—/);
  });

  it("with fish on the machine the value is written to profile.d and fish's conf.d, each in its own syntax", async () => {
    const link = scripted({ fish: true });
    const t = terminal();
    const { run } = stage(link, t, { asks: [{ name: "A_KEY", from: "cut from ~/.config/fish/config.fish" }] });
    await t.until("A_KEY");
    await t.press(...SECRET.split(""), KEY.enter);
    await t.until(`A_KEY: set in ${SH_FILE} and ${FISH_FILE} on the machine`);
    expect(await run).toEqual<SecretOutcome[]>([{ name: "A_KEY", from: "cut from ~/.config/fish/config.fish", state: "set" }]);
    const pty = writes(link)[0]!;
    expect(pty.created["env"]).toEqual({ PS1: "", WSP_SECRET_LINE: `export A_KEY='pa'\\''ss word'`, WSP_FISH_LINE: `set -gx A_KEY 'pa\\'ss word'` });
    expect(pty.ran).toBe(appendCommand(true));
  });

  it("on a machine without fish, a name already in the secrets file is not asked again and reads as set from an earlier run; nothing warns and nothing is appended twice", async () => {
    const link = scripted({ present: ["A_KEY"] });
    const t = terminal();
    const { run, hidden } = stage(link, t);
    await t.until("A_KEY: set on the machine from an earlier run");
    await t.until("B_TOKEN");
    await t.press("x", KEY.enter);
    const outcomes = await run;
    expect(t.text()).not.toContain("was not read");
    expect(t.text()).not.toMatch(/A_KEY\s*$/m);
    expect(outcomes).toEqual<SecretOutcome[]>([
      { name: "A_KEY", from: "cut from ~/.zshrc", state: "set", note: "on the machine from an earlier run" },
      { name: "B_TOKEN", from: "cut from ~/.zshrc", state: "set" },
    ]);
    expect(hidden).toEqual(["x"]);
    expect(writes(link)).toHaveLength(1);
    expect(writes(link)[0]!.created["env"]).toEqual({ PS1: "", WSP_SECRET_LINE: "export B_TOKEN='x'" });
  });

  it("a secrets file that cannot be read asks for every name and says so once", async () => {
    const link = scripted({ unreadable: true });
    const t = terminal();
    const { run } = stage(link, t);
    await t.until("The machine's secrets file was not read (the shell answered exit 2); every name is asked.");
    await t.until("A_KEY");
    await t.press("x", KEY.enter);
    await t.until("B_TOKEN");
    await t.press(KEY.enter);
    expect((await run).map(o => o.state)).toEqual(["set", "skipped"]);
  });

  it("an escape skips the name it was pressed on, and a shell that fails the append is not set with the exit", async () => {
    const link = scripted({ exit: 1 });
    const t = terminal();
    const { run } = stage(link, t);
    await t.until("A_KEY");
    await t.press("a", "b", KEY.esc);
    await t.until("A_KEY: skipped");
    await t.until("B_TOKEN");
    await t.press("x", KEY.enter);
    await t.until("B_TOKEN: not set");
    const outcomes = await run;
    expect(outcomes).toEqual<SecretOutcome[]>([
      { name: "A_KEY", from: "cut from ~/.zshrc", state: "skipped", note: "skipped by you" },
      { name: "B_TOKEN", from: "cut from ~/.zshrc", state: "failed", note: "the shell answered exit 1" },
    ]);
    expect(writes(link)).toHaveLength(1);
    expect(t.raw()).not.toContain("ab");
  });

  it("a link that drops under the append is not set with that reason, and the run goes on to the next name", async () => {
    const link = scripted();
    const read = link.script!;
    link.script = (pty, line) => (line.startsWith(readCommand()) ? read(pty, line) : link.drop());
    const t = terminal();
    const { run } = stage(link, t);
    await t.until("A_KEY");
    await t.press("x", KEY.enter);
    await t.until("A_KEY: not set (the machine's terminal link dropped)");
    await t.until("B_TOKEN");
    await t.press(KEY.enter);
    const outcomes = await run;
    expect(outcomes.map(o => o.state)).toEqual(["failed", "skipped"]);
  });

  it("with nobody to type, every name is skipped with the reason and no pty opens; with nothing cut, nothing is said", async () => {
    const link = scripted();
    const t = terminal();
    const { run } = stage(link, t, { skipWhy: "--yes asks nothing" });
    expect(await run).toEqual<SecretOutcome[]>([
      { name: "A_KEY", from: "cut from ~/.zshrc", state: "skipped", note: "--yes asks nothing" },
      { name: "B_TOKEN", from: "cut from ~/.zshrc", state: "skipped", note: "--yes asks nothing" },
    ]);
    expect(t.text()).toContain("Secrets skipped: A_KEY, B_TOKEN (cut from ~/.zshrc). --yes asks nothing.");
    expect(link.ptys).toEqual([]);
    const quiet = terminal();
    expect(await stage(link, quiet, { asks: [] }).run).toEqual([]);
    expect(quiet.text()).toBe("");
  });
});
