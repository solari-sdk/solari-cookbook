// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEPT_RUNS, openRunLog, redact, runLogPath, trimLines } from "../src/init-log.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "wsp-init-log-"));
  dirs.push(d);
  return d;
};
const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;

describe("redact", () => {
  it("blanks the value of every assignment whose name says key, token, secret or password, bare or quoted, and nothing else", () => {
    expect(redact("export ANTHROPIC_API_KEY=sk-ant-x123 HOMEBREW_NO_AUTO_UPDATE=1")).toBe("export ANTHROPIC_API_KEY=<redacted> HOMEBREW_NO_AUTO_UPDATE=1");
    expect(redact(`GH_TOKEN="gho_abc def" npm_token='x y' DB_PASSWORD=pw Client_Secret=s --token=t`)).toBe("GH_TOKEN=<redacted> npm_token=<redacted> DB_PASSWORD=<redacted> Client_Secret=<redacted> --token=<redacted>");
    expect(redact("PATH=/usr/bin CLAUDE_CONFIG_DIR=/root/.claude-cfg HOME=/root")).toBe("PATH=/usr/bin CLAUDE_CONFIG_DIR=/root/.claude-cfg HOME=/root");
    // A name that merely contains the word goes too: losing a keyboard layout beats keeping a key.
    expect(redact("keyboard=us")).toBe("keyboard=<redacted>");
  });

  it("blanks a hidden value wherever it appears, assignment or not", () => {
    expect(redact("Logged in with gho_fake; also gho_fake\n", ["gho_fake", ""])).toBe("Logged in with <redacted>; also <redacted>\n");
  });
});

describe("trimLines", () => {
  it("keeps a short block whole, cuts the middle of a long one with a count, and gives no line for nothing", () => {
    expect(trimLines("")).toEqual([]);
    expect(trimLines("a\nb\n")).toEqual(["a", "b"]);
    const long = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
    const cut = trimLines(long, 3, 2);
    expect(cut).toEqual(["l0", "l1", "l2", "(45 lines cut)", "l48", "l49"]);
  });
});

describe("run log", () => {
  it("sits beside the state file", () => {
    expect(runLogPath("/home/me/.wsp/state.json")).toBe("/home/me/.wsp/init.log");
  });

  it("writes one stamped line per frame and per exec, the command and trimmed output indented under the exec, secrets out", () => {
    const path = join(dir(), "init.log");
    let t = Date.parse("2026-09-05T10:00:00.000Z");
    const log = openRunLog(path, () => new Date((t += 1000)));
    log.hide("gho_fake");
    log.stage("creating", "sandbox from base");
    log.stage("ready");
    log.exec({ machineId: "m1", cmd: "df -Pk /root | awk 'NR==2{print $4}'", exitCode: 0, stdout: "2048000\n", stderr: "", ms: 1234 });
    log.exec({ machineId: "m1", cmd: "export GH_TOKEN=gho_fake\ngh auth status", exitCode: 1, stdout: "", stderr: "Logged in as me with gho_fake\nError: not logged in\n", ms: 80 });
    log.exec({ machineId: "m1", cmd: "true", error: "gone", ms: 5 });
    log.note("handoff http://127.0.0.1:4400/");
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("gho_fake");
    const lines = text.split("\n");
    expect(lines.filter(l => TS.test(l)).map(l => l.replace(TS, ""))).toEqual([
      `run ${log.id} wsp init (pid ${process.pid})`,
      "stage creating: sandbox from base",
      "stage ready",
      "exec m1 exit 0 1.2s",
      "exec m1 exit 1 0.1s",
      "exec m1 failed (gone) 0.0s",
      "note handoff http://127.0.0.1:4400/",
    ]);
    expect(lines.filter(l => l.startsWith("  "))).toEqual([
      "  $ df -Pk /root | awk 'NR==2{print $4}'",
      "  > 2048000",
      "  $ export GH_TOKEN=<redacted>",
      "  $ gh auth status",
      "  ! Logged in as me with <redacted>",
      "  ! Error: not logged in",
      "  $ true",
    ]);
    expect(lines[0]).toMatch(/^2026-09-05T10:00:01\.000Z run /);
    expect(lines[1]).toMatch(/^2026-09-05T10:00:02\.000Z stage creating/);
  });

  it("a long output keeps its first and last twenty lines", () => {
    const path = join(dir(), "init.log");
    const log = openRunLog(path);
    log.exec({ machineId: "m1", cmd: "brew install gh", exitCode: 1, stdout: Array.from({ length: 100 }, (_, i) => `out ${i}`).join("\n"), stderr: "", ms: 10 });
    const body = readFileSync(path, "utf8").split("\n").filter(l => l.startsWith("  > "));
    expect(body).toHaveLength(41);
    expect(body[0]).toBe("  > out 0");
    expect(body[19]).toBe("  > out 19");
    expect(body[20]).toBe("  > (60 lines cut)");
    expect(body[40]).toBe("  > out 99");
  });

  it("appends run after run and keeps the last five whole", () => {
    const path = join(dir(), "init.log");
    const ids: string[] = [];
    for (let i = 0; i < KEPT_RUNS + 2; i++) {
      const log = openRunLog(path);
      ids.push(log.id);
      log.stage("creating");
      log.note(`run number ${i}`);
    }
    const text = readFileSync(path, "utf8");
    const runs = text.split("\n").filter(l => / run [0-9a-f]+ wsp init/.test(l));
    expect(runs).toHaveLength(KEPT_RUNS);
    expect(runs.map(l => / run ([0-9a-f]+) /.exec(l)![1])).toEqual(ids.slice(-KEPT_RUNS));
    expect(text).not.toContain("run number 0");
    expect(text).not.toContain("run number 1");
    expect(text).toContain("run number 2");
    expect(text).toContain(`run number ${KEPT_RUNS + 1}`);
    // Nothing of a kept run is lost at the cut: its header still starts the file.
    expect(text.split("\n")[0]).toMatch(new RegExp(`^\\S+ run ${ids[2]} wsp init`));
  });

  it("a path that cannot be written never throws: the first failure is kept and later writes are skipped", () => {
    const path = join(dir(), "missing", "init.log");
    const log = openRunLog(path);
    expect(log.failed).toMatch(/ENOENT/);
    expect(() => log.stage("creating")).not.toThrow();
    expect(() => log.exec({ machineId: "m1", cmd: "true", exitCode: 0, stdout: "", stderr: "", ms: 1 })).not.toThrow();
    expect(log.failed).toMatch(/ENOENT/);
  });

  it("a file already there from an older run is appended to, never truncated under five runs", () => {
    const path = join(dir(), "init.log");
    writeFileSync(path, "2026-09-01T00:00:00.000Z run aaaaaa wsp init (pid 1)\n2026-09-01T00:00:01.000Z stage creating\n");
    openRunLog(path).note("second");
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("2026-09-01T00:00:00.000Z run aaaaaa")).toBe(true);
    expect(text).toContain("note second");
  });
});
