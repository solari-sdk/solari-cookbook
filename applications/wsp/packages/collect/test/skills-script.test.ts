// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSkills, SKILL_HEAD_BYTES, type SkillRootAt } from "../src/detect/skills.js";
import type { Host } from "../src/host.js";
import { nodeHost } from "../src/live-host.js";

// The reader as it stood with one head and one awk per SKILL.md, less a line's trailing CR: the new one must print exactly what this prints.
const PER_FILE_SCRIPT = [
  'for r in "$@"; do',
  '  [ -d "$r" ] || continue',
  '  find -L "$r" -mindepth 2 -maxdepth 3 \\( -name SKILL.md -o -name SKILL.md.off \\) -type f 2>/dev/null | while IFS= read -r f; do',
  '    d=${f%/*}',
  '    o=; case $f in *.off) [ -f "$d/SKILL.md" ] && continue; o=1;; esac',
  '    l=; [ -L "$d" ] && l=$(readlink "$d")',
  "    printf '\\036%s\\037%s\\037%s\\037%s\\037' \"$r\" \"$d\" \"$l\" \"$o\"",
  `    head -c ${SKILL_HEAD_BYTES} "$f" | awk '{sub(/\\r$/, "")} NR==1 && $0 != "---" {exit} NR>1 && $0 == "---" {exit} NR>1 {print}'`,
  "  done",
  "done",
  "printf '\\036END\\n'",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "wsp-skills-script-"));
  dirs.push(d);
  return d;
}

function skill(dir: string, text: string, file = "SKILL.md"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
}

const front = (name: string, body = ""): string => `---\nname: ${name}\ndescription: The ${name} skill, é and 字\n---\n${body}`;

/** A home with `n` plain skills over several roots, plus every odd shape the reader has to print the same way. */
function tree(base: string, n: number): SkillRootAt[] {
  const shared = join(base, "shared skills");
  const own = join(base, "own");
  const cats = join(base, "cats");
  for (const d of [shared, own, cats]) mkdirSync(d, { recursive: true });
  for (let i = 0; i < n; i++) {
    const root = i % 3 === 0 ? shared : i % 3 === 1 ? own : join(cats, `group ${i % 5}`);
    skill(join(root, `skill ${i}`), front(`skill-${i}`, "body\n".repeat(i % 7)));
    if (i % 10 === 0) symlinkSync(join(shared, `skill ${i - (i % 3)}`), join(own, `linked ${i}`));
    if (i % 12 === 0) symlinkSync(`../shared skills/skill ${i - (i % 3)}`, join(own, `rel ${i}`));
    if (i % 25 === 0) skill(join(own, `skill ${i}`), front(`skill-${i}`), "SKILL.md.off");
    if (i % 25 === 5) skill(join(shared, `off ${i}`), front(`off-${i}`), "SKILL.md.off");
  }
  skill(join(own, "open"), "---\nname: open\ndescription: never closed\nmore\n");
  skill(join(own, "crlf"), "---\r\nname: crlf\r\ndescription: windows\r\n---\r\n");
  skill(join(own, "crlf inside"), "---\nname: crlf-inside\r\ndescription: half\r\n---\n");
  skill(join(own, "empty"), "");
  skill(join(own, "no front"), "# Title\nname: nope\n");
  skill(join(own, "no newline"), "---\nname: tail");
  skill(join(own, "long open"), `---\nname: long\n${"description: a long line of words\n".repeat(300)}`);
  skill(join(own, "one line"), `---\n${"x".repeat(SKILL_HEAD_BYTES * 2)}\n---\n`);
  for (let k = -8; k <= 3; k++) {
    const pad = SKILL_HEAD_BYTES - 14 + k;
    skill(join(own, `edge ${k}`), `---\nname: ${"e".repeat(pad)}\n---\nafter\n`);
    skill(join(own, `wide ${k}`), `---\nname: ${"é".repeat(Math.floor(pad / 2))}${k % 2 === 0 ? "" : "e"}\n---\n`);
  }
  skill(join(own, ".hidden", "inner"), front("hidden"));
  skill(join(own, "outer"), front("outer"));
  skill(join(own, "outer", "examples"), front("inner"));
  skill(join(shared, "it's here"), front("quote"));
  symlinkSync(join(shared, "it's here"), join(own, "it's linked"));
  skill(join(shared, "a -> b"), front("arrow"));
  symlinkSync(join(shared, "a -> b"), join(own, "x -> y"));
  symlinkSync(join(base, "missing"), join(own, "dangling"));
  skill(join(own, "a\x1fsplit"), front("unit-separator"));
  skill(join(own, "a\x1erecord"), front("record-separator"));
  skill(join(own, "a\nline"), front("newline"));
  skill(join(own, "a\n\nblank"), front("blank-line"));
  skill(join(own, "locked"), front("locked"));
  chmodSync(join(own, "locked", "SKILL.md"), 0o000);
  return [own, shared, join(base, "absent"), join(cats, "group 0"), cats].map(dir => ({ dir, scope: "user" as const }));
}

/** The host with every sh run done by `shell` and the text each run printed kept. */
function recording(shell: string, env?: Record<string, string>): { host: Host; said: string[] } {
  const live = nodeHost();
  const said: string[] = [];
  const run: Host["exec"]["run"] = async (cmd, args, o) => {
    const out = await live.exec.run(cmd === "sh" ? shell : cmd, args, { ...o, ...(env !== undefined ? { env } : {}) });
    if (out !== undefined) said.push(out);
    return out;
  };
  return { host: { ...live, exec: { ...live.exec, run } }, said };
}

const shells = ["sh", "/bin/dash"].filter(s => s === "sh" || existsSync(s));

describe("the skills script", () => {
  for (const shell of shells) {
    it(`prints the same records as one head and awk per file did, under ${shell}`, async () => {
      const roots = tree(temp(), 300);
      const env = { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", QUOTING_STYLE: "shell-always" };
      const { host, said } = recording(shell, env);
      await detectSkills(host, roots);
      const before = await nodeHost().exec.run(shell, ["-c", PER_FILE_SCRIPT, "sh", ...roots.map(r => r.dir)], { timeoutMs: 60_000, env });
      expect(before).toBeDefined();
      expect(before!.split("\x1e").length).toBeGreaterThan(300);
      expect(said[0]!.split("\x1e").length).toBe(before!.split("\x1e").length);
      expect(said[0]).toBe(before);
    }, 60_000);

    it(`reads an awk that dies as a list cut short, under ${shell}`, async () => {
      const base = temp();
      const roots = tree(join(base, "home"), 3);
      const stubs = join(base, "stubs");
      mkdirSync(stubs);
      const real = ["/usr/bin/awk", "/bin/awk"].find(p => existsSync(p))!;
      writeFileSync(join(stubs, "awk"), `#!/bin/sh\n${real} "$@"\nexit 2\n`);
      chmodSync(join(stubs, "awk"), 0o755);
      const { host } = recording(shell, { PATH: `${stubs}:/usr/bin:/bin` });
      expect(await detectSkills(host, roots)).toEqual({ skills: [], refused: ["skills: the folders could not be read"] });
    });

    it(`starts as many processes for 300 skills as for 10, under ${shell}`, async () => {
      const count = async (n: number): Promise<number> => {
        const base = temp();
        const roots = tree(join(base, "home"), n);
        const stubs = join(base, "stubs");
        const log = join(base, "log");
        mkdirSync(stubs);
        writeFileSync(log, "");
        for (const bin of ["head", "awk", "readlink", "ls", "find", "cat", "stat"]) {
          const real = ["/usr/bin", "/bin"].map(d => join(d, bin)).find(p => existsSync(p));
          if (real === undefined) continue;
          writeFileSync(join(stubs, bin), `#!/bin/sh\necho ${bin} >> '${log}'\nexec ${real} "$@"\n`);
          chmodSync(join(stubs, bin), 0o755);
        }
        const { host } = recording(shell, { PATH: `${stubs}:/usr/bin:/bin` });
        const read = await detectSkills(host, roots);
        expect(read.refused).toEqual([]);
        return readFileSync(log, "utf8").split("\n").filter(l => l !== "").length;
      };
      expect(await count(300)).toBe(await count(10));
    }, 60_000);
  }
});
