// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { lineFeed } from "../src/child-exec.js";
import { carriedSshValues, holdBackForward, missingKnownHostsLine, sshBackArgs, type HeldChild, type SshCarried, type SshLocalRun, type SshReach } from "../src/ssh-backend.js";

const DEFAULTS = [
  "user root",
  "hostname 203.0.113.9",
  "port 22",
  "checkhostip no",
  "identitiesonly no",
  "hostkeyalgorithms ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512",
  "pubkeyacceptedalgorithms ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512",
  "identityfile ~/.ssh/id_rsa",
  "identityfile ~/.ssh/id_ed25519",
  "globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2",
  "userknownhostsfile /Users/dev/.ssh/known_hosts /Users/dev/.ssh/known_hosts2",
  "addkeystoagent false",
  "clearallforwardings no",
];

/** Known hosts files that are on this computer, since a child is never handed one that is not. */
const HOSTS_DIR = mkdtempSync(join(tmpdir(), "wsp-known-"));
const hostsFile = (name: string): string => {
  const path = join(HOSTS_DIR, name);
  writeFileSync(path, "");
  return path;
};
const GOOGLE_HOSTS = hostsFile("google_compute_known_hosts");

const JUMPBOX_PROXY = "/opt/homebrew/bin/python3 -S /opt/sdk/gcloud.py compute start-iap-tunnel jumpbox %p --listen-on-stdin --project=p --zone=z";

/** The owner's jumpbox block as `ssh -G` answers it: a tunnel command with a token the child expands, the name
 * its key is filed under and the file it is filed in, and the LocalForwards a block like spoo's carries too. */
const JUMPBOX = [
  "user dev_example",
  "hostname compute.1234567890",
  "port 22",
  "checkhostip no",
  "identitiesonly yes",
  "hostkeyalias compute.1234567890",
  "hostkeyalgorithms ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512",
  "pubkeyacceptedalgorithms ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512",
  "identityfile ~/.ssh/google_compute_engine",
  "globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2",
  `userknownhostsfile ${GOOGLE_HOSTS}`,
  "addkeystoagent yes",
  "localforward 8080 [127.0.0.1]:8080",
  `proxycommand ${JUMPBOX_PROXY}`,
];

/** `ssh -G` without the person's config for the same dial, and with it: the fake tells them apart by `-F /dev/null`
 * and records each ask, and never starts a client. */
function fakeConfig(withConfig: string[], hostname = "203.0.113.9", user = "root"): { run: SshLocalRun; asked: string[][] } {
  const asked: string[][] = [];
  const run: SshLocalRun = async (file, args) => {
    asked.push([file, ...args]);
    const bare = args.includes("/dev/null");
    const dialed = args.includes("-p") ? args[args.indexOf("-p") + 1] : "22";
    const lines = (bare ? DEFAULTS.map(l => l.replace(/^user .*/, `user ${user}`).replace(/^hostname .*/, `hostname ${hostname}`)) : withConfig).map(l => l.replace(/^port .*/, `port ${dialed}`));
    return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  };
  return { run, asked };
}

/** A child that never leaves this process: the test writes its output and ends it, and reads what the holder did. */
function fakeChild(): { child: HeldChild; stdout: PassThrough; stderr: PassThrough; stdinEnded: () => boolean; killed: string[]; exit: (code: number | null, signal?: string) => void } {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let ended = false;
  stdin.on("finish", () => (ended = true));
  const killed: string[] = [];
  const child: HeldChild = {
    stdin,
    stdout,
    stderr,
    kill: signal => {
      killed.push(signal ?? "SIGTERM");
      return true;
    },
    once: (event: string, fn: Parameters<EventEmitter["once"]>[1]) => events.once(event, fn),
  };
  stdin.resume();
  return { child, stdout, stderr, stdinEnded: () => ended, killed, exit: (code, signal) => events.emit("exit", code, signal ?? null) };
}

const CARRIED: SshCarried = { reach: { user: "root", host: "box", port: 22 }, options: [] };

const tick = (): Promise<void> => new Promise(r => setImmediate(r));

describe("the ssh dial-back forward", () => {
  it("a plain host dials with no config, its own target and only its own -R, held open by a remote cat", async () => {
    const reach: SshReach = { user: "root", host: "203.0.113.9", port: 22 };
    const { run, asked } = fakeConfig(DEFAULTS);
    const values = await carriedSshValues(reach, run);
    expect(asked.every(a => a[0] === "ssh" && a.includes("-G") && a.at(-1) === "root@203.0.113.9")).toBe(true);
    expect(asked.some(a => a.includes("-F") && a.includes("/dev/null"))).toBe(true);
    const args = sshBackArgs(values, 4640, 4640);
    expect(args.slice(0, 2)).toEqual(["-F", "/dev/null"]);
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("ServerAliveInterval=15");
    expect(args).toContain("ServerAliveCountMax=3");
    expect(args).toContain("ControlPath=none");
    expect(args).toContain("-T");
    expect(args).not.toContain("-N");
    expect(args[args.indexOf("-p") + 1]).toBe("22");
    expect(args.filter(a => a === "-R")).toHaveLength(1);
    expect(args[args.indexOf("-R") + 1]).toBe("127.0.0.1:4640:127.0.0.1:4640");
    expect(args.slice(-2)).toEqual(["root@203.0.113.9", "echo WSP_BACK_UP; exec cat"]);
    // The client's defaults are the child's defaults under -F /dev/null; spelling them out would only pin the
    // host key algorithms and lose the client's preference for the type known_hosts already holds.
    expect(args.join(" ")).not.toMatch(/HostKeyAlgorithms|IdentityFile|UserKnownHostsFile|ProxyCommand|HostKeyAlias/);
    expect(args.join(" ")).not.toMatch(/LocalForward|ClearAllForwardings/);
  });

  it("the jumpbox block's tunnel, key name, key file and identity ride along behind -F /dev/null, its LocalForward does not", async () => {
    const reach: SshReach = { user: "dev_example", host: "jumpbox", port: 22 };
    const { run } = fakeConfig(JUMPBOX, "jumpbox", "dev_example");
    const args = sshBackArgs(await carriedSshValues(reach, run), 4640, 4640);
    expect(args.slice(0, 2)).toEqual(["-F", "/dev/null"]);
    const options = args.flatMap((a, i) => (args[i - 1] === "-o" ? [a] : []));
    expect(options).toEqual(expect.arrayContaining([
      `ProxyCommand=${JUMPBOX_PROXY}`,
      "HostKeyAlias=compute.1234567890",
      `UserKnownHostsFile=${GOOGLE_HOSTS}`,
      "IdentityFile=~/.ssh/google_compute_engine",
      "IdentitiesOnly=yes",
      "AddKeysToAgent=yes",
    ]));
    expect(options.join(" ")).not.toMatch(/LocalForward|CheckHostIP|HostKeyAlgorithms/);
    expect(args[args.indexOf("-R") + 1]).toBe("127.0.0.1:4640:127.0.0.1:4640");
    expect(args.slice(-2)).toEqual(["dev_example@compute.1234567890", "echo WSP_BACK_UP; exec cat"]);
  });

  it("a config that turns CheckHostIP on or names several identities carries each, at the port the read was asked for", async () => {
    const reach: SshReach = { user: "root", host: "box", port: 2222 };
    const block = DEFAULTS.map(l => l.replace(/^checkhostip .*/, "checkhostip yes")).filter(l => !l.startsWith("identityfile ")).concat("identityfile ~/.ssh/a", "identityfile ~/.ssh/b");
    const { run } = fakeConfig(block, "box");
    const args = sshBackArgs(await carriedSshValues(reach, run), 4640, 4640);
    expect(args).toContain("CheckHostIP=yes");
    expect(args.filter(a => a.startsWith("IdentityFile="))).toEqual(["IdentityFile=~/.ssh/a", "IdentityFile=~/.ssh/b"]);
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });

  it("a carried path with a space is quoted so ssh reads it as one value, a list and a command stay as ssh printed them", async () => {
    const reach: SshReach = { user: "root", host: "box", port: 22 };
    const [known, work] = [hostsFile("known_hosts"), hostsFile("work_hosts")];
    const agent = "/Users/dev/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock";
    const block = DEFAULTS.filter(l => !l.startsWith("identityfile ") && !l.startsWith("userknownhostsfile ")).concat(
      `identityagent ${agent}`,
      "identityfile ~/keys/my key",
      "identityfile ~/.ssh/id_ed25519",
      'identityfile ~/odd/a"b\\c',
      `userknownhostsfile ${known} ${work}`,
      "proxycommand nc -X 5 -x proxy:1080 %h %p",
    );
    const { run } = fakeConfig(block, "box");
    const options = sshBackArgs(await carriedSshValues(reach, run), 4640, 4640).flatMap((a, i, all) => (all[i - 1] === "-o" ? [a] : []));
    expect(options).toEqual(expect.arrayContaining([
      `IdentityAgent="${agent}"`,
      'IdentityFile="~/keys/my key"',
      "IdentityFile=~/.ssh/id_ed25519",
      'IdentityFile="~/odd/a\\"b\\\\c"',
      `UserKnownHostsFile=${known} ${work}`,
      "ProxyCommand=nc -X 5 -x proxy:1080 %h %p",
    ]));
  });

  it("a ProxyJump rides as the command ssh would build for it, the jump keeping the person's config", async () => {
    const reach: SshReach = { user: "root", host: "inner", port: 22 };
    const { run } = fakeConfig([...DEFAULTS.map(l => l.replace(/^hostname .*/, "hostname 10.0.0.7")), "proxyjump bastion,ops@edge:2222"], "inner");
    const args = sshBackArgs(await carriedSshValues(reach, run), 4640, 4640);
    expect(args).toContain("ProxyCommand=ssh -o BatchMode=yes -J 'bastion' -W '[%h]:%p' 'ssh://ops@edge:2222'");
    expect(args.join(" ")).not.toMatch(/ProxyJump/);
    expect(args.at(-2)).toBe("root@10.0.0.7");
  });

  it("a known hosts file the config names that is not on this computer refuses the forward, a path with a space included", async () => {
    const reach: SshReach = { user: "root", host: "box", port: 22 };
    const kept = hostsFile("kept_hosts");
    // How ssh -G prints `UserKnownHostsFile "~/my hosts"`: expanded, and joined by spaces with the quotes gone.
    const spaced = `${join(HOSTS_DIR, "my")} hosts`;
    for (const [list, missing] of [
      [`${kept} ${join(HOSTS_DIR, "gone")}`, join(HOSTS_DIR, "gone")],
      [spaced, join(HOSTS_DIR, "my")],
    ] as const) {
      const { run } = fakeConfig([...DEFAULTS.filter(l => !l.startsWith("userknownhostsfile ")), `userknownhostsfile ${list}`], "box");
      await expect(carriedSshValues(reach, run)).rejects.toThrow(missingKnownHostsLine("root@box", missing));
    }
    const { run } = fakeConfig([...DEFAULTS.filter(l => !l.startsWith("globalknownhostsfile ")), "globalknownhostsfile none"], "box");
    expect((await carriedSshValues(reach, run)).options).toContain("GlobalKnownHostsFile=none");
    expect(missingKnownHostsLine("root@box", "/x".repeat(400)).length).toBeLessThanOrEqual(300);
    for (const long of [missingKnownHostsLine("root@box", "/x".repeat(400)), missingKnownHostsLine(`${"u".repeat(255)}@box`, "/etc/ssh/hosts")]) {
      expect(long.length).toBeLessThanOrEqual(300);
      expect(long).toContain("create it, or rename a path that has a space in it");
    }
  });

  it("a literal % in the agent's path is doubled, since ssh -G printed it already expanded and the child expands it again", async () => {
    const reach: SshReach = { user: "root", host: "box", port: 22 };
    const { run } = fakeConfig([...DEFAULTS, "identityagent /Users/dev/%h", "certificatefile ~/.ssh/%h-cert.pub"], "box");
    const options = sshBackArgs(await carriedSshValues(reach, run), 4640, 4640);
    expect(options).toContain("IdentityAgent=/Users/dev/%%h");
    expect(options).toContain("CertificateFile=~/.ssh/%h-cert.pub");
  });

  it("a config ssh cannot read is refused with ssh's own line", async () => {
    const run: SshLocalRun = async () => ({ exitCode: 255, stdout: "", stderr: "/Users/dev/.ssh/config line 3: Bad configuration option: frob\n" });
    await expect(carriedSshValues({ user: "root", host: "box", port: 22 }, run)).rejects.toThrow("Bad configuration option: frob");
  });

  it("the forward is up when the box echoes WSP_BACK_UP, and no line on stderr, which the box writes too, stands for it", async () => {
    const fake = fakeChild();
    const spawned: string[][] = [];
    const held = holdBackForward(CARRIED, 4640, 4640, (file, args) => {
      spawned.push([file, ...args]);
      return fake.child;
    });
    expect(spawned).toEqual([["ssh", ...sshBackArgs(CARRIED, 4640, 4640)]]);
    let settled = false;
    void held.up.then(() => (settled = true));
    fake.stderr.write("Allocated port 41234 for remote forward to 127.0.0.1:4640\n");
    await tick();
    expect(settled).toBe(false);
    fake.stdout.write("WSP_BACK_UP\n");
    await expect(held.up).resolves.toBeUndefined();
    expect(fake.stdinEnded()).toBe(false);
  });

  it("a line the box wrote on stderr reaches the host with no control characters in it", async () => {
    const fake = fakeChild();
    const held = holdBackForward(CARRIED, 4640, 4640, () => fake.child);
    fake.stderr.write("\x1b]0;pwned\x07motd from the box\x1b[2J\n");
    await tick();
    fake.exit(255);
    await expect(held.ended).resolves.toBe("]0;pwnedmotd from the box[2J");
  });

  it("a child that ends before it is up rejects with ssh's last line", async () => {
    const fake = fakeChild();
    const held = holdBackForward(CARRIED, 4640, 4640, () => fake.child);
    fake.stderr.write("Warning: Permanently added 'box' (ED25519) to the list of known hosts.\n");
    fake.stderr.write("Warning: remote port forwarding failed for listen port 4640\n");
    fake.stderr.write("Error: remote port forwarding failed for listen port 4640\n");
    await tick();
    fake.exit(255);
    await expect(held.up).rejects.toThrow("Error: remote port forwarding failed for listen port 4640");
    await expect(held.ended).resolves.toBe("Error: remote port forwarding failed for listen port 4640");
  });

  it("a child that says nothing but ssh's own known_hosts note says its exit code", async () => {
    const fake = fakeChild();
    const held = holdBackForward(CARRIED, 4640, 4640, () => fake.child);
    fake.stderr.write("Warning: Permanently added 'box' (ED25519) to the list of known hosts.\n");
    await tick();
    fake.exit(255);
    await expect(held.up).rejects.toThrow("ssh exited with 255");
  });

  it("releasing the holder closes the child's stdin, which ends cat on the box, and stops the child", async () => {
    const fake = fakeChild();
    const held = holdBackForward(CARRIED, 4640, 4640, () => fake.child);
    fake.stdout.write("WSP_BACK_UP\n");
    await held.up;
    held.release();
    await tick();
    expect(fake.stdinEnded()).toBe(true);
    expect(fake.killed).toEqual(["SIGTERM"]);
    fake.exit(null, "SIGTERM");
    await expect(held.ended).resolves.toBe("ssh ended on SIGTERM");
  });

  it("a box that writes without a newline leaves only a bounded tail held", () => {
    const lines: string[] = [];
    const feed = lineFeed(line => lines.push(line), 4096);
    const chunk = "x".repeat(65536);
    for (let i = 0; i < 64; i++) feed.feed(chunk);
    feed.flush();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(4096);
  });

  it("a newline-free flood on stderr still lets the up line and ssh's last line through", async () => {
    const fake = fakeChild();
    const held = holdBackForward(CARRIED, 4640, 4640, () => fake.child);
    const chunk = "x".repeat(65536);
    for (let i = 0; i < 64; i++) fake.stderr.write(chunk);
    fake.stdout.write("WSP_BACK_UP\n");
    await expect(held.up).resolves.toBeUndefined();
    for (let i = 0; i < 64; i++) fake.stderr.write(chunk);
    await tick();
    fake.exit(255);
    expect((await held.ended).length).toBeLessThanOrEqual(300);
  });

  it("a child that ends after it was up resolves ended with its last line", async () => {
    const fake = fakeChild();
    const held = holdBackForward(CARRIED, 4640, 4640, () => fake.child);
    fake.stdout.write("WSP_BACK_UP\n");
    await held.up;
    fake.stderr.write("Timeout, server box not responding.\n");
    await tick();
    fake.exit(255);
    await expect(held.ended).resolves.toBe("Timeout, server box not responding.");
  });
});
