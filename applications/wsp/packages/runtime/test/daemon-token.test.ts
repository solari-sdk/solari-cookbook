// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DAEMON_TOKEN_PATH } from "@wsp/protocol";
import { DAEMON_TOKEN_NONE, DAEMON_TOKEN_SET, assertTokenShape, daemonTokenFor, daemonTokenPathOf, rotateDaemonTokenScript, writeDaemonTokenScript } from "../src/daemon-token.js";
import type { Machine } from "@wsp/engine";

const TOKEN = "0123456789abcdef".repeat(3);

describe("where a machine's daemon token is written", () => {
  const machine = (daemonTokenPath?: string): Machine => ({ id: "m1", daemonTokenPath } as unknown as Machine);

  it("takes the machine's own file where it names one, whatever road asked, and the road's otherwise", () => {
    // A stand-in machine's guest is a folder on the computer asking, and a shell there cannot write under the root
    // of a Linux machine that does not exist. One road asked for the guest's path on such a machine, found no
    // token, and every other road read that miss for a minute: the terminal, the files and the live readings all
    // said the machine had not answered.
    expect(daemonTokenPathOf(machine("/tmp/stand-in/m1/.wsp-daemon-token"), DAEMON_TOKEN_PATH)).toBe("/tmp/stand-in/m1/.wsp-daemon-token");
    expect(daemonTokenPathOf(machine("/tmp/stand-in/m1/.wsp-daemon-token"))).toBe("/tmp/stand-in/m1/.wsp-daemon-token");
    // A machine that names none is every machine wsp forks and every one it reaches over ssh: the road decides.
    expect(daemonTokenPathOf(machine(), DAEMON_TOKEN_PATH)).toBe(DAEMON_TOKEN_PATH);
    expect(daemonTokenPathOf(machine(), "/home/dev/.wsp/daemon-token")).toBe("/home/dev/.wsp/daemon-token");
    // Nothing asked and nothing named leaves the rotation's own default standing.
    expect(daemonTokenPathOf(machine())).toBeUndefined();
  });
});

describe("a machine's own daemon token", () => {
  it("is the seed's one answer for that machine: the same machine twice, never another machine's, never another seed's", () => {
    // A token read off one machine opens that machine alone: one token rotated onto every machine let a box that
    // was taken over hold what every other machine of that host accepts.
    expect(daemonTokenFor(TOKEN, "m1")).toBe(daemonTokenFor(TOKEN, "m1"));
    expect(daemonTokenFor(TOKEN, "m1")).not.toBe(daemonTokenFor(TOKEN, "m2"));
    expect(daemonTokenFor(TOKEN, "m1")).not.toBe(daemonTokenFor("beefcafe".repeat(3), "m1"));
  });

  it("is hex, so the write needs no quoting, and a seed that is not hex is refused where it is given", () => {
    expect(daemonTokenFor(TOKEN, "m1")).toMatch(/^[0-9a-f]+$/);
    expect(() => daemonTokenFor("it's not hex", "m1")).toThrow(/hex/);
  });
});

describe("daemon token scripts", () => {
  it("write the token only inside a NAME='value' assignment, owner-readable, replaced whole", () => {
    const script = writeDaemonTokenScript(TOKEN);
    const lines = script.split("\n");
    expect(lines[0]).toBe(`WSP_DAEMON_TOKEN='${TOKEN}'`);
    expect(lines.slice(1).join("\n")).not.toContain(TOKEN);
    expect(lines.indexOf("umask 077")).toBeLessThan(lines.findIndex(l => l.startsWith("printf")));
    expect(script).toContain(`> ${DAEMON_TOKEN_PATH}.next`);
    expect(script).toContain(`mv -f ${DAEMON_TOKEN_PATH}.next ${DAEMON_TOKEN_PATH}`);
  });

  it("rotate leaves a machine without a daemon alone and names each outcome on stdout", () => {
    const script = rotateDaemonTokenScript(TOKEN);
    expect(script.startsWith(`test -f ${DAEMON_TOKEN_PATH} || { echo ${DAEMON_TOKEN_NONE}; exit 0; }\n`)).toBe(true);
    expect(script).toContain(writeDaemonTokenScript(TOKEN));
    expect(script.endsWith(`\necho ${DAEMON_TOKEN_SET}`)).toBe(true);
  });

  it("refuse anything but hex, so the quoting above is always enough", () => {
    expect(() => assertTokenShape("")).toThrow(/hex/);
    expect(() => assertTokenShape("it's-not-hex-at-all-000")).toThrow(/hex/);
    expect(() => writeDaemonTokenScript("'; rm -rf /; echo '0123456789abcdef")).toThrow(/hex/);
    expect(() => assertTokenShape(TOKEN)).not.toThrow();
  });
});
