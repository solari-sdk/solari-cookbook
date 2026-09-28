// SPDX-License-Identifier: AGPL-3.0-only
// The one reader of what a machine says it is, over fixtures taken off real
// machines: an Ubuntu box, a Mac, and one that answers with neither.
import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/machine.js";
import { MEM_READ, OS_READ, UPTIME_READ, memMbOf, osNameOf, readOsName, readValues, uptimeMsOf } from "../src/machine-facts.js";

/** What the lines print on an Ubuntu box: no product version, a distribution name, and the seconds /proc keeps. */
const UBUNTU = "pretty Ubuntu 24.04.3 LTS\nmac \nkernel Linux 6.8.0-79-generic\nuptime 96521.42\nboot \nhome /home/dev\n";
/** What they print on a Mac: no /etc/os-release, no /proc, and a boot time instead of a length. */
const MAC = "pretty \nmac 26.4\nkernel Darwin 25.4.0\nuptime \nboot { sec = 1789041249, usec = 855807 } Thu Sep 10 17:24:09 2026\nhome /Users/zingzy\n";

describe("what a machine says it is", () => {
  it("reads one answer per line, and a line whose command printed nothing is an answer the machine does not have", () => {
    expect(readValues(UBUNTU)).toEqual({ pretty: "Ubuntu 24.04.3 LTS", mac: "", kernel: "Linux 6.8.0-79-generic", uptime: "96521.42", boot: "", home: "/home/dev" });
    expect(readValues("")).toEqual({});
    expect(readValues("kernel Linux 6.8.0\n")).toEqual({ kernel: "Linux 6.8.0" });
  });

  it("names the system the way its maker does: the product version on a Mac, the distribution's own name on a Linux, the kernel where neither answered", () => {
    expect(osNameOf(readValues(MAC))).toBe("macOS 26.4");
    expect(osNameOf(readValues(UBUNTU))).toBe("Ubuntu 24.04.3 LTS");
    expect(osNameOf(readValues("pretty \nmac \nkernel FreeBSD 14.1-RELEASE\n"))).toBe("FreeBSD 14.1-RELEASE");
    // A machine that ran none of the lines has no name here: the caller says what it knows instead of guessing.
    expect(osNameOf(readValues("pretty \nmac \nkernel \n"))).toBeUndefined();
    expect(osNameOf({})).toBeUndefined();
  });

  it("takes the length /proc keeps, and works one out against the clock where the machine answered with the moment it booted", () => {
    expect(uptimeMsOf(readValues(UBUNTU), Date.now())).toBe(96_521_420);
    expect(uptimeMsOf(readValues(MAC), 1_789_041_249_000 + 3_600_000)).toBe(3_600_000);
    // A clock behind the machine's own boot time reads as just up rather than as a negative length.
    expect(uptimeMsOf(readValues(MAC), 1_789_041_249_000 - 5_000)).toBe(0);
    expect(uptimeMsOf(readValues("uptime \nboot \n"), Date.now())).toBeUndefined();
    expect(uptimeMsOf({}, Date.now())).toBeUndefined();
  });

  it("reads the memory line in whole MB, and nothing where the line printed no figure", () => {
    expect(memMbOf(readValues("memkb 4128768\n"))).toBe(4032);
    expect(memMbOf(readValues("memkb 8060000\n"))).toBe(7871);
    expect(memMbOf(readValues("memkb \n"))).toBeUndefined();
    expect(memMbOf(readValues("memkb 0\n"))).toBeUndefined();
    expect(memMbOf({})).toBeUndefined();
    expect(MEM_READ.startsWith('printf "memkb ')).toBe(true);
  });

  it("one command asks for the name, and a machine that could not run it leaves the caller without one", async () => {
    const asked: string[] = [];
    const exec = (out: Partial<ExecResult>) => async (cmd: string): Promise<ExecResult> => {
      asked.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "", ...out };
    };
    expect(await readOsName(exec({ stdout: UBUNTU }))).toBe("Ubuntu 24.04.3 LTS");
    expect(asked).toEqual([OS_READ.join("\n")]);
    expect(await readOsName(exec({ exitCode: 127, stdout: UBUNTU }))).toBeUndefined();
    expect(await readOsName(async () => Promise.reject(new Error("spawn failed")))).toBeUndefined();
    // Nothing in the lines reads this process: they are what a machine anywhere is asked, over whatever road reaches it.
    for (const line of [...OS_READ, ...UPTIME_READ]) expect(line.startsWith("printf ")).toBe(true);
  });
});
