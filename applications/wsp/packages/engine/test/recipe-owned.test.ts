// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { RecipeDigest, RecipeOwnedFile } from "@wsp/protocol";
import { EXEC_BODY_MAX } from "@wsp/protocol";
import { execFits } from "../src/exec-detached.js";
import { ownedFilesScript, parseOwnedFiles, readOwnedFiles, recipeOwnedFiles, recipeWrittenPaths, upgradePlan } from "../src/recipe-owned.js";
import type { ExecResult, Machine } from "../src/machine.js";

const owned = (rows: Record<string, string>): RecipeOwnedFile[] => Object.entries(rows).map(([path, sha256]) => ({ path, sha256 }));

function reader(answer: ExecResult): { machine: Machine; cmds: string[] } {
  const cmds: string[] = [];
  const machine: Machine = {
    id: "m1", kind: "sandbox", streamUrl: undefined,
    exec: async cmd => {
      cmds.push(cmd);
      return answer;
    },
    run: async () => answer,
    snapshot: async () => "snap", pause: async () => {}, resume: async () => {},
    kill: async () => {}, state: async () => "running" as const,
    downloadUrl: async () => "https://x", uploadUrl: async () => "https://x",
  };
  return { machine, cmds };
}

describe("the recipe's own files", () => {
  it("the written paths are the recipe's dests, each once and in order, and the rows it marks volatile are named apart", () => {
    const recipe: RecipeDigest = {
      ticks: [],
      files: [
        { id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest: "d" },
        { id: "agents/claude", path: "~/.claude", dest: ".claude", digest: "d" },
        { id: "logins/claude", path: "~/.claude.json", dest: ".claude.json", digest: "d", volatile: true },
      ],
    };
    expect(recipeWrittenPaths(recipe)).toEqual({ paths: [".claude", ".claude.json", ".zshrc"], volatile: [".claude.json"] });
  });

  it("the manifest a seal records marks every file under a volatile row, so its bytes never stand for a person's edit", async () => {
    const recipe: RecipeDigest = {
      ticks: [],
      files: [
        { id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest: "d" },
        { id: "agents/claude", path: "~/.claude/plugins", dest: ".claude/plugins", digest: "d", volatile: true },
      ],
    };
    const { machine } = reader({ exitCode: 0, stdout: `${"a".repeat(64)}  .zshrc\n${"b".repeat(64)}  .claude/plugins/installed_plugins.json\n`, stderr: "" });
    expect(await recipeOwnedFiles(machine, recipe)).toEqual([
      { path: ".claude/plugins/installed_plugins.json", sha256: "b".repeat(64), volatile: true },
      { path: ".zshrc", sha256: "a".repeat(64) },
    ]);
  });

  it("the read runs one command from the home the paths are relative to and a path no longer there is nothing, not an error", async () => {
    const { machine, cmds } = reader({ exitCode: 0, stdout: `${"a".repeat(64)}  .zshrc\n`, stderr: "" });
    expect(await readOwnedFiles(machine, [".zshrc", ".gone"])).toEqual([{ path: ".zshrc", sha256: "a".repeat(64) }]);
    expect(cmds).toEqual([ownedFilesScript("/root", [".zshrc", ".gone"])]);
    expect(cmds[0]).toContain("2>/dev/null");
  });

  it("a home the read cannot reach fails loudly rather than answering an empty list, which would read as a fork that changed everything", async () => {
    const { machine } = reader({ exitCode: 1, stdout: "", stderr: "no such directory" });
    await expect(readOwnedFiles(machine, [".zshrc"])).rejects.toThrow("reading the recipe's files on m1 failed");
    expect(ownedFilesScript("/root", [".zshrc"])).toContain("|| exit 1");
    expect(ownedFilesScript("/root", [".zshrc"])).not.toContain("|| true");
  });

  it("a thousand paths go a page at a time under the one measured exec cap, so the provider refuses none of them with a 413", async () => {
    const paths = Array.from({ length: 1_000 }, (_, i) => `.claude/skills/skill-${i}/SKILL.md`);
    const { machine, cmds } = reader({ exitCode: 0, stdout: "", stderr: "" });
    await readOwnedFiles(machine, paths);
    expect(cmds.length).toBeGreaterThan(1);
    for (const cmd of cmds) expect(execFits(cmd), `${Buffer.byteLength(cmd)} bytes against ${EXEC_BODY_MAX}`).toBe(true);
    expect(paths.filter(p => cmds.filter(c => c.includes(`'${p}'`)).length === 1)).toHaveLength(paths.length);
  });

  it("a name sha256sum had to escape is left out rather than read as a path with a backslash on it", () => {
    const line = `${"a".repeat(64)}  .zshrc`;
    expect(parseOwnedFiles(`\\${line}\n${line}\n\n`)).toEqual([{ path: ".zshrc", sha256: "a".repeat(64) }]);
  });

  it("nothing is asked of the machine when the recipe wrote no file", async () => {
    const { machine, cmds } = reader({ exitCode: 1, stdout: "", stderr: "nope" });
    expect(await readOwnedFiles(machine, [])).toEqual([]);
    expect(cmds).toEqual([]);
  });
});

describe("what an upgrade does with them", () => {
  const from = owned({ ".zshrc": "a", ".gitconfig": "b", ".claude/settings.json": "c" });
  const to = owned({ ".zshrc": "a2", ".gitconfig": "b", ".claude/settings.json": "c2", ".config/gh/hosts.yml": "n" });

  it("a file the fork never touched is dropped so the new image's copy stands, and is not on the kept list", () => {
    const plan = upgradePlan(from, to, owned({ ".zshrc": "a", ".gitconfig": "b", ".claude/settings.json": "c" }));
    expect(plan).toEqual({ drop: [".claude/settings.json", ".config/gh/hosts.yml", ".gitconfig", ".zshrc"], kept: [], fallback: false });
  });

  it("a file the fork changed travels and is named on the kept list", () => {
    const plan = upgradePlan(from, to, owned({ ".zshrc": "mine", ".gitconfig": "b", ".claude/settings.json": "c" }));
    expect(plan.kept).toEqual([".zshrc"]);
    expect(plan.drop).not.toContain(".zshrc");
  });

  it("a file the fork deleted is the new image's copy standing, not the fork's edit winning: tar carries no deletion, so it is dropped and never named as kept", () => {
    const plan = upgradePlan(from, to, owned({ ".gitconfig": "b", ".claude/settings.json": "c" }));
    expect(plan.kept).toEqual([]);
    expect(plan.drop).toContain(".zshrc");
  });

  it("a volatile file travels as the fork's but is never named: its bytes move on their own, so a differing hash is no person's edit", () => {
    const withVolatile = [...from, { path: ".claude.json", sha256: "v", volatile: true as const }];
    const plan = upgradePlan(withVolatile, to, owned({ ".zshrc": "a", ".gitconfig": "b", ".claude/settings.json": "c", ".claude.json": "rewritten-on-every-run" }));
    expect(plan.kept).toEqual([]);
    expect(plan.drop).not.toContain(".claude.json");
  });

  it("a path only the new image writes is dropped whether or not the fork holds one, so the image's copy is what lands", () => {
    expect(upgradePlan(from, to, owned({})).drop).toContain(".config/gh/hosts.yml");
    expect(upgradePlan(from, to, owned({ ".config/gh/hosts.yml": "forks-own" })).drop).toContain(".config/gh/hosts.yml");
  });

  it("a volatile row the new image adds leaves the fork's own copy alone when it has one, and is dropped when it has none so the folder it sits in cannot land over the image's", () => {
    const gains = [...to, { path: ".claude.json", sha256: "fresh", volatile: true as const }];
    expect(upgradePlan(from, gains, owned({ ".claude.json": "the fork's own state" })).drop).not.toContain(".claude.json");
    expect(upgradePlan(from, gains, owned({})).drop).toContain(".claude.json");
  });

  it("a path in no manifest is nobody's but the fork's and never appears in the plan", () => {
    const plan = upgradePlan(from, to, owned({ ".zshrc": "a", "proj/src/a.ts": "p", ".claude/projects/s.jsonl": "s" }));
    expect(plan.drop).not.toContain("proj/src/a.ts");
    expect(plan.drop).not.toContain(".claude/projects/s.jsonl");
    expect(plan.kept).not.toContain("proj/src/a.ts");
  });

  it("a version that recorded no files of its own falls back: nothing is dropped and the fallback is said", () => {
    expect(upgradePlan(undefined, to, owned({ ".zshrc": "mine" }))).toEqual({ drop: [], kept: [], fallback: true });
  });

  it("a newer image that recorded none still leaves the fork's own image's files to the comparison", () => {
    expect(upgradePlan(from, undefined, owned({ ".zshrc": "a", ".gitconfig": "mine", ".claude/settings.json": "c" }))).toEqual({
      drop: [".claude/settings.json", ".zshrc"],
      kept: [".gitconfig"],
      fallback: false,
    });
  });
});
