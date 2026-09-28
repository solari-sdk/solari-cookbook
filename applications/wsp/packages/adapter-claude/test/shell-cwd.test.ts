// SPDX-License-Identifier: AGPL-3.0-only
// Where the agent's tool shell is, read from its tool calls.
import { describe, expect, it } from "vitest";

import { shellCwdAfter } from "../src/shell-cwd.js";

const ROOT = "/root";

describe("shellCwdAfter", () => {
  it("follows a Bash command that begins with cd to an absolute path", () => {
    expect(shellCwdAfter("Bash", { command: "cd /root/2048" }, ROOT, ROOT)).toBe("/root/2048");
    expect(shellCwdAfter("Bash", { command: "cd /root/2048 && npm test" }, ROOT, ROOT)).toBe("/root/2048");
    expect(shellCwdAfter("Bash", { command: "cd /root/2048; ls" }, ROOT, ROOT)).toBe("/root/2048");
    expect(shellCwdAfter("Bash", { command: "  cd '/root/my game' && ls" }, ROOT, ROOT)).toBe("/root/my game");
    expect(shellCwdAfter("Bash", { command: 'cd "/root/2048/" \n ls' }, ROOT, ROOT)).toBe("/root/2048");
    expect(shellCwdAfter("Bash", { command: "cd /root/2048/../tetris" }, ROOT, ROOT)).toBe("/root/tetris");
    expect(shellCwdAfter("Bash", { command: "cd /tmp" }, ROOT, ROOT)).toBe("/tmp");
  });

  it("ignores a cd that is relative, not first, or not a cd", () => {
    expect(shellCwdAfter("Bash", { command: "cd 2048" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd ~/2048" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd -" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "ls && cd /root/2048" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cdx /root/2048" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "echo cd /root/2048" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd /root/2048" }, "/root/2048", ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", {}, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", null, ROOT, ROOT)).toBeUndefined();
  });

  it("ignores a cd whose path the shell would still expand", () => {
    expect(shellCwdAfter("Bash", { command: "cd /root/$PROJ && ls" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd /root/${PROJ}/src" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd /root/*/src" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd /root/204?" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd /root/[ab]/src" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd /root/{a,b}" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd /root/`basename x`" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd /root/$(ls | head -1)" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd /root/~x" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: 'cd "$(pwd)/x"' }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: 'cd "/root/$PROJ" && ls' }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: 'cd "/root/`id -un`"' }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Bash", { command: "cd '/root/$literal'" }, ROOT, ROOT)).toBe("/root/$literal");
  });

  it("takes the parent of a Write or Edit path under the harness folder while the shell is still there", () => {
    expect(shellCwdAfter("Write", { file_path: "/root/2048/index.html", content: "" }, ROOT, ROOT)).toBe("/root/2048");
    expect(shellCwdAfter("Edit", { file_path: "/root/2048/src/game.js" }, ROOT, ROOT)).toBe("/root/2048/src");
    expect(shellCwdAfter("Write", { file_path: "/root/notes.md" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Write", { file_path: "/etc/hosts" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Write", { file_path: "relative/x.ts" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter("Read", { file_path: "/root/2048/index.html" }, ROOT, ROOT)).toBeUndefined();
    expect(shellCwdAfter(undefined, { file_path: "/root/2048/index.html" }, ROOT, ROOT)).toBeUndefined();
  });

  it("never drills deeper into the folder already followed, but picks up a folder beside it", () => {
    expect(shellCwdAfter("Write", { file_path: "/root/2048/src/game.js" }, "/root/2048", ROOT)).toBeUndefined();
    expect(shellCwdAfter("Edit", { file_path: "/root/2048/index.html" }, "/root/2048", ROOT)).toBeUndefined();
    expect(shellCwdAfter("Write", { file_path: "/root/tetris/index.html" }, "/root/2048", ROOT)).toBe("/root/tetris");
    expect(shellCwdAfter("Write", { file_path: "/root/2048-old/x" }, "/root/2048", ROOT)).toBe("/root/2048-old");
    expect(shellCwdAfter("Write", { file_path: "/tmp/x" }, "/root/2048", ROOT)).toBeUndefined();
  });
});
