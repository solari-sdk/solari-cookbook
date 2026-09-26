// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DAEMON_NICE, DAEMON_OOM_SCORE_ADJ, WORK_OOM_SCORE_ADJ, workArgv, workScoreLine } from "../src/index.js";

describe("who the kernel takes first", () => {
  it("the daemon is killed last but never exempt, runs ahead of default priority, and the work sits above zero", () => {
    expect(DAEMON_OOM_SCORE_ADJ).toBe(-999);
    expect(WORK_OOM_SCORE_ADJ).toBeGreaterThan(0);
    expect(WORK_OOM_SCORE_ADJ).toBeLessThanOrEqual(1000);
    expect(DAEMON_NICE).toBeLessThan(0);
    expect(DAEMON_NICE).toBeGreaterThanOrEqual(-20);
  });

  it("the sh line writes the work score to the running shell's own entry and puts it back at the default priority, quietly", () => {
    expect(workScoreLine()).toBe("{ echo 500 > /proc/self/oom_score_adj; } 2>/dev/null; renice 0 $$ >/dev/null 2>&1");
    expect(workScoreLine(0)).toBe("{ echo 0 > /proc/self/oom_score_adj; } 2>/dev/null; renice 0 $$ >/dev/null 2>&1");
  });

  it("a command the daemon launches runs behind that line as argv, exec'd into, never interpolated", () => {
    expect(workArgv("git", ["status", "a b", "c'd"])).toEqual({
      file: "/bin/sh",
      args: ["-c", `${workScoreLine()}; exec "$0" "$@"`, "git", "status", "a b", "c'd"],
    });
    expect(workArgv("/usr/bin/zsh", ["-l"]).args.slice(-2)).toEqual(["/usr/bin/zsh", "-l"]);
  });
});
