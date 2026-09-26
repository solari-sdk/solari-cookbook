// SPDX-License-Identifier: AGPL-3.0-only
// The line wsp init ends on and the ssh forward under it, both read off the
// address the host bound: the forward is advice only when the address the page
// is on answers on the computer the host runs on and nowhere else. On a
// terminal the person is at, the browser is opened on a page in the host's run
// folder that sends it to the address, so the code in the address rides no
// process argument.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { appUrl } from "../src/init-first.js";
import { openApp } from "../src/init-serve.js";

const SSH = { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.9 22" };
const CODE = "7K3MQP2X";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One openApp run at one address, with what it printed, what it asked a browser to open, the run folder it wrote
 * into and what it left for the run's exit. */
async function run(o: { address?: string; env?: Record<string, string | undefined>; interactive?: boolean; code?: string; workspaceId?: string }): Promise<{ text: string; opened: string[]; runDir: string; atExit: (() => void)[]; url: string }> {
  const chunks: string[] = [];
  const output = new PassThrough();
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const opened: string[] = [];
  const atExit: (() => void)[] = [];
  const at = { port: 4400, address: o.address };
  const runDir = join(mkdtempSync(join(tmpdir(), "wsp-init-serve-")), "runs");
  dirs.push(runDir);
  const url = appUrl(at, o.workspaceId, o.code);
  await openApp(
    url,
    at,
    {
      output,
      env: o.env ?? {},
      open: (target: string) => {
        opened.push(target);
        return Promise.resolve(true);
      },
      atExit: fn => atExit.push(fn),
    },
    o.interactive ?? true,
    { runDir },
  );
  return { text: stripVTControlCharacters(chunks.join("")), opened, runDir, atExit, url };
}

describe("the address wsp init hands over, and the ssh forward under it", () => {
  it("over ssh, a host on this computer alone prints the forward, spelled with the address the page is on", async () => {
    const { text, opened } = await run({ env: SSH });
    expect(text).toContain("Open http://127.0.0.1:4400/");
    expect(text).toContain("ssh -L 4400:127.0.0.1:4400 <this host>");
    expect(opened).toEqual([]);
  });

  it("over ssh, a host on an address beyond this computer prints that address and no forward, since the page is already there", async () => {
    const { text } = await run({ address: "100.64.0.3", env: SSH });
    expect(text).toContain("Open http://100.64.0.3:4400/");
    expect(text).not.toContain("ssh -L");
    expect(text).not.toContain("forward");
  });

  it("over ssh, a loopback address spelled another way still gets a forward, through the one authority rule", async () => {
    const { text } = await run({ address: "::1", env: SSH });
    expect(text).toContain("Open http://[::1]:4400/");
    expect(text).toContain("ssh -L 4400:[::1]:4400 <this host>");
  });

  it("over ssh, an IPv6 address beyond this computer prints bracketed and gets no forward", async () => {
    const { text } = await run({ address: "2001:db8::5", env: SSH });
    expect(text).toContain("Open http://[2001:db8::5]:4400/");
    expect(text).not.toContain("ssh -L");
  });

  it("over ssh, a wildcard bind keeps the forward: the page is handed over at loopback, which is the one address a wildcard is not dialled at", async () => {
    const { text } = await run({ address: "0.0.0.0", env: SSH });
    expect(text).toContain("Open http://127.0.0.1:4400/");
    expect(text).toContain("ssh -L 4400:127.0.0.1:4400 <this host>");
  });

  it("off a terminal but not over ssh, the address is printed with no forward: nobody here is on the far side of one", async () => {
    const { text, opened } = await run({ interactive: false });
    expect(text).toContain("Open http://127.0.0.1:4400/");
    expect(text).not.toContain("ssh -L");
    expect(opened).toEqual([]);
  });

  it("on a terminal the person is at, the browser opens on a page in the run folder that sends it to the address, and nothing about ssh is said", async () => {
    const { text, opened, runDir, url } = await run({ address: "100.64.0.3", code: CODE, workspaceId: "ws_1" });
    expect(url).toBe(`http://100.64.0.3:4400/#w/ws_1/c/${CODE}`);
    expect(text).toContain(`Opened ${url}`);
    expect(text).not.toContain("ssh -L");
    // The browser is handed the page, never the address: a process argument is every process's to read.
    expect(opened).toHaveLength(1);
    const page = opened[0]!;
    expect(page.startsWith(`${runDir}/`)).toBe(true);
    expect(page.endsWith(".html")).toBe(true);
    expect(readdirSync(runDir)).toEqual([page.slice(runDir.length + 1)]);
    const html = readFileSync(page, "utf8");
    expect(html).toContain(`<meta http-equiv="refresh" content="0; url=${url}">`);
    expect(html).toContain(`<a href="${url}">`);
    // The owner's login alone reads it: the file and the folder it sits in.
    expect(statSync(page).mode & 0o777).toBe(0o600);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
  });

  it("the page is gone at the run's exit, and nothing else in the run folder goes with it", async () => {
    const { opened, atExit, runDir } = await run({ code: CODE });
    const page = opened[0]!;
    expect(existsSync(page)).toBe(true);
    expect(atExit).toHaveLength(1);
    atExit[0]!();
    expect(existsSync(page)).toBe(false);
    expect(existsSync(runDir)).toBe(true);
  });

  it("under --yes or over ssh no page is written: the address with its code is printed into the person's own terminal", async () => {
    for (const o of [{ interactive: false }, { env: SSH }]) {
      const { text, opened, runDir, url } = await run({ ...o, code: CODE, workspaceId: "ws_1" });
      expect(url).toBe(`http://127.0.0.1:4400/#w/ws_1/c/${CODE}`);
      expect(text).toContain(`Open ${url}`);
      expect(opened).toEqual([]);
      expect(existsSync(runDir)).toBe(false);
    }
  });

  it("an address on no workspace still carries the code, on its own", async () => {
    const { url } = await run({ interactive: false, code: CODE });
    expect(url).toBe(`http://127.0.0.1:4400/#c/${CODE}`);
  });
});
