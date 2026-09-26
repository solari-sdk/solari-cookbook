// SPDX-License-Identifier: AGPL-3.0-only
// wsp recipe scan: every option this computer offers, what to do about each
// and why, and nothing written.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alsoTitle } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { runScan, type RecipeIo } from "../src/recipe-command.js";
import { FLOOR_LINE, USED_GROUP, type TableRow } from "../src/init-table.js";
import { COMMANDS_TITLE, NOT_SCANNED, RecipeScan, SIGN_INS_TITLE, alsoHereLines, scanPrintout, signInAdvice, tickAdvice } from "../src/recipe-answer.js";
import { claudeLine, fakeHost, HOME } from "./recipe-fixture.js";
import { loginOf } from "./signin-questions.js";

const PROJ = `${HOME}/proj`;
const MB = 1024 * 1024;
const quiet: RecipeIo = { log: () => {}, note: () => {} };
const at = () => new Date("2026-09-06T03:00:00Z");

/** Claude Code and Java here; node, pnpm, gh, wrangler and go in the agent's own sessions past the floor, and
 * pulumi, which the catalog does not carry. */
const laptop = () =>
  fakeHost({
    which: ["claude", "java"],
    files: {
      "~/.claude/settings.json": "{}",
      "~/.claude/projects/-Users-dev-proj/s1.jsonl": [claudeLine("s1", PROJ, ["node --version", "pnpm install", "pulumi -q"]), claudeLine("s1", PROJ, ["gh pr view", "gh pr checks", "gh run list", "wrangler dev", "wrangler tail"])].join("\n"),
      "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", PROJ, ["pnpm test", "node build.js", "gh pr list", "gh pr merge", "wrangler deploy", "wrangler tail", "wrangler dev"]),
      "~/.claude/projects/-Users-dev-other/s3.jsonl": claudeLine("s3", `${HOME}/other`, ["go build ./...", "go test ./...", "go vet ./..."]),
      "~/.claude/projects/-Users-dev-other/s4.jsonl": claudeLine("s4", `${HOME}/other`, ["go build ./...", "go mod tidy"]),
    },
  });

describe("wsp recipe scan", () => {
  it("writes nothing, and answers with the agents, the tools, the commands and the sign-ins in one read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-scan-"));
    const scan = RecipeScan.parse(await runScan(laptop(), {}, quiet, at));
    expect(existsSync(join(dir, "recipe.json"))).toBe(false);
    expect(scan.tick).toBe("used");
    expect(scan.at).toBe("2026-09-06T03:00:00.000Z");
    expect(scan.agents.map(r => r.id).sort()).toEqual(["amp", "claude", "codex", "crush", "gemini", "goose", "hermes", "opencode", "pi", "qwen"]);
    expect(scan.tools.find(r => r.id === "curl")).toMatchObject({ on: true });
    expect(scan.tools.find(r => r.id === "java")).toMatchObject({ on: false, why: "installed here, never used" });
    expect(scan.commands.map(c => c.name)).toEqual(["pulumi"]);
    expect(scan.signIns.map(r => r.id)).toEqual(["claude", "gh", "wrangler"]);
    expect(scan.signIns.find(r => r.id === "gh")).toMatchObject({ signIn: loginOf("gh") });
    rmSync(dir, { recursive: true, force: true });
  });

  it("recommends an agent on only when it was used here and wsp can run its threads, and says which held it off", async () => {
    const codexRollout = [JSON.stringify({ type: "session_meta", payload: { id: "t1", cwd: PROJ } }), JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "cargo build" }) } })].join("\n");
    const host = fakeHost({
      which: ["claude", "codex", "opencode"],
      files: {
        "~/.claude/settings.json": "{}",
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", PROJ, ["gh pr list"]),
        "~/.codex/config.toml": "",
        "~/.codex/sessions/2026/06/01/rollout-2026-06-01T10-00-00-t1.jsonl": codexRollout,
      },
    });
    const scan = RecipeScan.parse(await runScan(host, {}, quiet, at));
    const agent = (id: string) => scan.agents.find(r => r.id === id)!;
    expect(agent("claude")).toMatchObject({ on: true, recommended: { value: "on", why: "used here, 1 session" } });
    expect(agent("codex")).toMatchObject({ on: true, recommended: { value: "on", why: "used here, 1 session; 455 MB on the machine, worth a question" } });
    expect(agent("opencode")).toMatchObject({ on: false, recommended: { value: "off", why: "installed here, never used" } });
  });

  it("carries what to do with every row and one line of why, so an agent applies the rest and asks about the delta", async () => {
    const scan = await runScan(laptop(), {}, quiet, at);
    expect(scan.tools.find(r => r.id === "curl")?.recommended).toEqual({ value: "on", why: "always on the image" });
    expect(scan.tools.find(r => r.id === "java")?.recommended).toEqual({ value: "off", why: "installed here, never used" });
    for (const row of [...scan.agents, ...scan.tools]) expect(row.recommended.value, row.id).toBe(row.on ? "on" : "off");
    for (const row of scan.signIns) expect(row.recommended.why.length, row.id).toBeGreaterThan(0);
    expect(scan.signIns.find(r => r.id === "claude")?.recommended.value).toBe("token");
  });

  it("says a heavy row is worth a question in the same line, and nothing else is", () => {
    const row: TableRow = { id: "opencode", name: "OpenCode", kind: "agent", base: false, group: USED_GROUP, why: "used here, 2 sessions", size: 673 * MB, heavy: true, on: true };
    const heavy = tickAdvice({ ...row, on: true });
    expect(heavy).toEqual({ value: "on", why: "used here, 2 sessions; 673 MB on the machine, worth a question" });
    // Off, so nothing is being added and there is nothing to ask about.
    expect(tickAdvice({ ...row, on: false }).why).toBe("used here, 2 sessions");
    // An agent used here that wsp cannot run threads on says so beside its why, since the why alone argues for on.
    expect(tickAdvice({ ...row, on: false, note: "installs, but wsp cannot run its threads yet" }).why).toBe("used here, 2 sessions; installs, but wsp cannot run its threads yet");
    expect(tickAdvice({ ...row, id: "node", kind: "tool", on: true, heavy: false, size: 250 * MB }).why).toBe("used here, 2 sessions");
  });

  it("recommends off under the floor and says the counts and the floor, a heavy row against its own", async () => {
    const under = fakeHost({
      files: {
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", PROJ, ["vercel --version", "vercel -v", "railway up", "railway status", "java -jar a.jar", "java -jar b.jar", "java -jar c.jar"]),
        "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", PROJ, ["java -jar a.jar"]),
        "~/.claude/projects/-Users-dev-proj/s3.jsonl": claudeLine("s3", PROJ, ["java -jar a.jar"]),
      },
    });
    const scan = await runScan(under, {}, quiet, at);
    const tool = (s: Awaited<ReturnType<typeof runScan>>, id: string) => s.tools.find(r => r.id === id)!;
    // Two version checks in one session are not a use: the row is back on the catalog's own evidence.
    expect(tool(scan, "vercel")).toMatchObject({ on: false, why: "in the catalog, on request", recommended: { value: "off", why: "in the catalog, on request" } });
    expect(tool(scan, "railway")).toMatchObject({ on: false, why: "below the floor, 2 commands in 1 session", recommended: { value: "off", why: "below the floor, 2 commands in 1 session" } });
    expect(tool(scan, "java")).toMatchObject({ on: false, heavy: true, why: "heavy, below the floor, 5 commands in 3 sessions", recommended: { value: "off", why: "heavy, below the floor, 5 commands in 3 sessions" } });
    const many = (cmd: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${cmd} step${i}`);
    const over = fakeHost({
      files: {
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", PROJ, [...many("java", 27), ...many("wrangler", 5)]),
        "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", PROJ, ["java -jar a.jar", "wrangler dev"]),
        "~/.claude/projects/-Users-dev-proj/s3.jsonl": claudeLine("s3", PROJ, ["java -jar a.jar"]),
        "~/.claude/projects/-Users-dev-proj/s4.jsonl": claudeLine("s4", PROJ, ["java -jar a.jar"]),
      },
    });
    const past = await runScan(over, {}, quiet, at);
    expect(tool(past, "java")).toMatchObject({ on: true, why: "30 commands in 4 sessions", recommended: { value: "on", why: "30 commands in 4 sessions; 585 MB on the machine, worth a question" } });
    expect(tool(past, "wrangler")).toMatchObject({ on: true, why: "6 commands in 2 sessions", recommended: { value: "on", why: "6 commands in 2 sessions" } });
    // The footer names the floor once, right under the Tools table's totals.
    const lines = scanPrintout(scan, "darwin");
    expect(lines.filter(l => l === FLOOR_LINE)).toHaveLength(1);
    expect(lines[lines.indexOf(FLOOR_LINE) - 1]).toMatch(/^On: \d+ tools/);
  });

  it("recommends the key files where a login cannot produce them, the token where the tool mints one here, and the machine where a browser can", () => {
    // Hermes signs in on the machine and its keys file cannot be produced there, so key gets both.
    expect(signInAdvice("hermes")).toMatchObject({ value: "key" });
    expect(signInAdvice("claude")).toMatchObject({ value: "token", why: "claude setup-token runs here and the token is set on every turn; nothing of it is on any machine" });
    expect(signInAdvice("codex")).toMatchObject({ value: "later", why: "it signs in once on the computer that runs the workspaces, never on a machine of its own" });
    expect(signInAdvice("gh")).toMatchObject({ value: "machine" });
  });

  it("prints the heading for the tools no catalog row carries, telling nothing looked from nothing found", () => {
    expect(alsoHereLines({ scanned: false, managers: [] }, "darwin")).toEqual([alsoTitle("darwin"), `  ${NOT_SCANNED}`]);
    expect(alsoHereLines({ scanned: true, managers: [] }, "darwin")).toEqual([alsoTitle("darwin"), "  none"]);
    // On a computer that is not a Mac the heading says so, and nothing else about the section changes.
    expect(alsoHereLines({ scanned: true, managers: [] }, "linux")).toEqual(["Also on this computer", "  none"]);
    const lines = alsoHereLines({ scanned: true, managers: [{ manager: "brew", rows: [{ id: "jj", install: "brew install jj", size: 40 * MB }] }] }, "darwin");
    expect(lines[1]).toBe("  brew");
    expect(lines[2]).toBe("    jj  brew install jj  40 MB");
  });

  it("prints every section in order, the do column beside each row", async () => {
    const lines = scanPrintout(await runScan(laptop(), {}, quiet, at), "darwin");
    expect(lines[0]).toBe("Agents");
    // The shared renderer's own line, with the one column the scan adds.
    expect(lines.find(l => l.includes("Java 21"))).toMatch(/^○ {2}Java 21\s+installed\s+installed here, never used\s+585 MB {2}off$/);
    expect(lines).toContain("Tools");
    expect(lines).toContain(alsoTitle("darwin"));
    expect(lines).toContain(`  ${NOT_SCANNED}`);
    expect(lines).toContain(COMMANDS_TITLE);
    expect(lines).toContain(SIGN_INS_TITLE);
    expect(lines.find(l => l.includes("Claude Code"))).toMatch(/^● {2}Claude Code\s+used\s+used here, 4 sessions\s+208 MB {2}on$/);
    // The shared renderer's totals line, one under each table.
    expect(lines.filter(l => l.startsWith("On: "))).toHaveLength(2);
  });

  it("weighs the histories by the folders it is given, as the write verb does", async () => {
    expect((await runScan(laptop(), {}, quiet, at)).tools.find(r => r.id === "go")).toMatchObject({ on: true });
    expect((await runScan(laptop(), { projects: [PROJ] }, quiet, at)).tools.find(r => r.id === "go")).toMatchObject({ on: false });
  });
});
