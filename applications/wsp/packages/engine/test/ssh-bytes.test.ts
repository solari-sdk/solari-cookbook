// SPDX-License-Identifier: AGPL-3.0-only
// The one road bytes take onto a machine. A provider that mints a signed URL
// gets a PUT; a machine that mints none carries the bytes over the connection
// that runs its commands. Both callers that put a file on a machine read the
// machine for which, so nothing above them says which kind it holds.
import { describe, expect, it } from "vitest";
import { SSH_BYTES_OK, SshBackend, landBytes, putBytesScript, sshArgs, type ExecResult, type Machine, type SshReach, type SshTransport } from "../src/index.js";

const REACH: SshReach = { user: "maya", host: "box", port: 2222 };

/** An ssh client that never leaves this computer: it keeps every script it was asked to carry and the bytes that
 * rode stdin with it, and answers the way the machine's own script would. */
function fakeTransport(): { transport: SshTransport; carried: { script: string; stdin?: Uint8Array }[] } {
  const carried: { script: string; stdin?: Uint8Array }[] = [];
  const transport: SshTransport = async (_reach, script, opts) => {
    carried.push({ script, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    return { exitCode: 0, stdout: `${SSH_BYTES_OK}\n`, stderr: "" };
  };
  return { transport, carried };
}

describe("bytes onto a machine reached over ssh", () => {
  it("ride the connection's stdin under a script that names the path", async () => {
    const { transport, carried } = fakeTransport();
    const machine = await new SshBackend({ transport }).get("ssh://maya@box:2222");
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await machine.putBytes!("/home/maya/.wsp/daemon.tgz", bytes);
    expect(carried).toHaveLength(1);
    expect(carried[0]!.stdin).toEqual(bytes);
    expect(carried[0]!.script).toContain("cat > '/home/maya/.wsp/daemon.tgz.wsp-in-");
    expect(carried[0]!.script).toContain("mkdir -p '/home/maya/.wsp'");
    // Into place only once the count matches: a connection cut halfway must leave the target as it was rather
    // than a file that looks whole.
    expect(carried[0]!.script).toContain("= 5 ]");
    expect(carried[0]!.script).toMatch(/mv -f '[^']*\.wsp-in-[0-9a-f]+' '\/home\/maya\/\.wsp\/daemon\.tgz'/);
  });

  it("keeps the connection's stdin for the file, so the client is not given -n on that one road", () => {
    expect(sshArgs(REACH, "cat > x", { stdin: true })).not.toContain("-n");
    expect(sshArgs(REACH, "echo hi")).toContain("-n");
  });

  it("says what did not land rather than leaving a half file behind", async () => {
    const transport: SshTransport = async () => ({ exitCode: 1, stdout: "WSP_BYTES_SHORT\n", stderr: "" });
    const machine = await new SshBackend({ transport }).get("ssh://maya@box:2222");
    await expect(machine.putBytes!("/home/maya/x", new Uint8Array(9))).rejects.toThrow("9 bytes did not land at /home/maya/x over ssh (exit 1)");
  });

  it("names the bytes, the path and the temporary name it lands under", () => {
    const s = putBytesScript("/home/maya/f", 12, "/home/maya/f.tmp");
    expect(s.split("\n")[0]).toBe("set -e");
    expect(s).toContain(`echo ${SSH_BYTES_OK}`);
  });
});

/** A machine that mints a signed URL and carries no bytes of its own, which is what every provider backend is. */
function urlMachine(puts: { url: string; bytes: Uint8Array }[]): Machine {
  const no = async (): Promise<never> => {
    throw new Error("not in this test");
  };
  return {
    id: "m1",
    kind: "sandbox",
    exec: no,
    run: no,
    snapshot: no,
    pause: no,
    resume: no,
    kill: no,
    state: no,
    downloadUrl: no,
    uploadUrl: async (path: string) => `https://signed.example/${path}`,
  } as unknown as Machine & { uploadUrl(path: string): Promise<string> } & { _: typeof puts };
}

describe("landBytes", () => {
  it("takes the machine's own road when it has one", async () => {
    const { transport, carried } = fakeTransport();
    const machine = await new SshBackend({ transport }).get("ssh://maya@box:2222");
    await landBytes(machine, "/home/maya/f", new Uint8Array([7, 7]));
    expect(carried).toHaveLength(1);
    expect(carried[0]!.stdin).toEqual(new Uint8Array([7, 7]));
  });

  it("mints a signed URL and PUTs where the machine carries no bytes itself", async () => {
    const puts: { url: string; bytes: Uint8Array }[] = [];
    const machine = urlMachine(puts);
    const doFetch = (async (url: string, init: { body: Uint8Array }) => {
      puts.push({ url, bytes: init.body });
      return { ok: true, status: 200, text: async () => "" };
    }) as unknown as typeof fetch;
    await landBytes(machine, "/root/wsp-daemon.tgz", new Uint8Array([9]), { fetch: doFetch });
    expect(puts).toEqual([{ url: "https://signed.example//root/wsp-daemon.tgz", bytes: new Uint8Array([9]) }]);
  });
});
