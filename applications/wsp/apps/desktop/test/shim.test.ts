// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command the app installs: a small shell script under the wsp home
// that runs this app's own binary as node on the bundled command, written
// where the MCP install's one constant says, rewritten when the app moved.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonBinaryHere, shimPath } from "@wsp/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installShim, shimText } from "../src/shim.js";

describe("the wsp shim", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-desktop-shim-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("runs the app's binary as node on the bundled command with every argument, paths with spaces quoted", () => {
    const text = shimText({ execPath: "/Applications/My Tools/wsp.app/Contents/MacOS/wsp", script: "/Applications/My Tools/wsp.app/Contents/Resources/app/main/cli.mjs" });
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain(`ELECTRON_RUN_AS_NODE=1 exec '/Applications/My Tools/wsp.app/Contents/MacOS/wsp' '/Applications/My Tools/wsp.app/Contents/Resources/app/main/cli.mjs' "$@"`);
    // Run for real with node standing in for the app's binary: the script the shim names gets the arguments.
    writeFileSync(join(home, "cli.mjs"), 'console.log(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE, ...process.argv.slice(2)]));\n');
    const path = shimPath(join(home, ".wsp"));
    expect(installShim(path, shimText({ execPath: process.execPath, script: join(home, "cli.mjs") }))).toBe("written");
    const ran = spawnSync(path, ["mcp", "install", "--agent", "a b"], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual(["1", "mcp", "install", "--agent", "a b"]);
  });

  it("puts the daemon's forwarder in front of the bundled command where the bundle carries one, and every line still reaches that command whole", () => {
    const text = shimText({ execPath: "/Applications/My Tools/wsp.app/Contents/MacOS/wsp", script: "/Applications/My Tools/wsp.app/Contents/Resources/app/main/cli.mjs", daemon: "/Applications/My Tools/wsp.app/Contents/Resources/app/assets/daemon/aarch64-apple-darwin/wsp-daemon" });
    expect(text).toContain(
      `ELECTRON_RUN_AS_NODE=1 exec '/Applications/My Tools/wsp.app/Contents/Resources/app/assets/daemon/aarch64-apple-darwin/wsp-daemon' forward --wsp-argv '/Applications/My Tools/wsp.app/Contents/MacOS/wsp' --wsp-argv '/Applications/My Tools/wsp.app/Contents/Resources/app/main/cli.mjs' -- "$@"`,
    );
    // Run for real: the built forwarder, with node standing in for the app's binary. A line that is not the tool
    // server goes straight to the command; a tool server line with no host serving it is asked once and then goes
    // there too, so the command prints once either way.
    // The stand-in answers the forwarder's ask with nothing, which is a line no host serves.
    writeFileSync(join(home, "cli.mjs"), 'const { WSP_FORWARD: asked } = process.env;\nif (!asked) console.log(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE, ...process.argv.slice(2)]));\n');
    const path = shimPath(join(home, ".wsp"));
    installShim(path, shimText({ execPath: process.execPath, script: join(home, "cli.mjs"), daemon: daemonBinaryHere() }));
    for (const line of [["threads", "--json", "a b"], ["mcp", "install", "--agent", "a b"]]) {
      const ran = spawnSync(path, line, { encoding: "utf8" });
      expect(ran.status, ran.stderr).toBe(0);
      expect(ran.stdout.trim().split("\n").map(l => JSON.parse(l) as unknown)).toEqual([["1", ...line]]);
    }
  });

  it("writes the shim executable where the MCP install's constant says, keeps one that already says the same, and rewrites one that names another app", () => {
    const path = shimPath(join(home, ".wsp"));
    expect(existsSync(path)).toBe(false);
    const text = shimText({ execPath: "/Applications/wsp.app/Contents/MacOS/wsp", script: "/Applications/wsp.app/Contents/Resources/app/main/cli.mjs" });
    expect(installShim(path, text)).toBe("written");
    expect(path).toBe(join(home, ".wsp", "bin", "wsp"));
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(installShim(path, text)).toBe("kept");
    const moved = shimText({ execPath: "/Users/me/Downloads/wsp.app/Contents/MacOS/wsp", script: "/Users/me/Downloads/wsp.app/Contents/Resources/app/main/cli.mjs" });
    expect(installShim(path, moved)).toBe("written");
    expect(readFileSync(path, "utf8")).toBe(moved);
  });
});
