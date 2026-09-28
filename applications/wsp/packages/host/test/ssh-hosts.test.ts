// SPDX-License-Identifier: AGPL-3.0-only
import { GIT_FORGE_HOSTS, isGitForge, SshHostSuggestion } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { sshHostsIn, type SshFiles } from "../src/ssh-hosts.js";

const SSH = "/home/lena/.ssh";

/** An ssh folder held in memory: every path a read may touch, and nothing else. */
function folder(files: Record<string, string>): SshFiles & { read: SshFiles["read"]; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    read: path => {
      reads.push(path);
      return files[path];
    },
    list: dir => {
      const names = Object.keys(files)
        .filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
        .map(path => path.slice(dir.length + 1));
      return names.length === 0 ? undefined : names;
    },
  };
}

describe("the ssh hosts offered where a computer is added", () => {
  it("reads every named Host block of the config with its HostName, User and Port, and skips the patterns", () => {
    const files = folder({
      [`${SSH}/config`]: [
        "# my boxes",
        "Host *",
        "  User everyone",
        "  ServerAliveInterval 30",
        "",
        "Host hetzner",
        "  HostName 65.21.4.12",
        "  User root",
        "  Port 2222",
        "host   attic pi",
        "  hostname=192.168.1.40",
        '  USER "lena"',
        "Host *.corp !bastion web? build",
        "  User ci",
        "Match host build exec true",
        "  User nobody",
        "Host hetzner",
        "  User someone-else",
        "  Port 22",
        "Host broken",
        "  Port many",
        `Host ${"x".repeat(301)} fine`,
        `  User ${"u".repeat(301)}`,
      ].join("\n"),
    });
    expect(sshHostsIn(SSH, [], files)).toEqual([
      { alias: "hetzner", hostName: "65.21.4.12", user: "root", port: 2222, from: "config" },
      { alias: "attic", hostName: "192.168.1.40", user: "lena", from: "config" },
      { alias: "pi", hostName: "192.168.1.40", user: "lena", from: "config" },
      { alias: "build", user: "ci", from: "config" },
      { alias: "broken", from: "config" },
    ]);
  });

  it("follows Include lines relative to the ssh folder, from the home folder and by glob, once each", () => {
    const files = folder({
      [`${SSH}/config`]: ["Include config.d/*", "Include ~/.ssh/work", "Include /etc/ssh/extra missing", "Include config", "Host last"].join("\n"),
      [`${SSH}/config.d/b.conf`]: "Host bee\n  HostName b.example.com",
      [`${SSH}/config.d/a.conf`]: "Host ay\n  HostName a.example.com\nInclude config",
      [`${SSH}/work`]: "Host work\n  User lena",
      "/etc/ssh/extra": "Host extra",
    });
    expect(sshHostsIn(SSH, [], files).map(h => h.alias)).toEqual(["ay", "bee", "work", "extra", "last"]);
    // The home folder's own tilde: the ssh folder's parent, never a path this computer's user happens to have.
    expect(files.reads).toContain(`${SSH}/work`);
    expect(files.reads.filter(path => path === `${SSH}/config`)).toHaveLength(1);
  });

  it("reads known_hosts names and bracketed ports, and skips hashed lines, markers, patterns and what the config already names", () => {
    const files = folder({
      [`${SSH}/config`]: "Host hetzner\n  HostName 65.21.4.12",
      [`${SSH}/known_hosts`]: [
        "# comment",
        "example.org,140.82.121.4 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
        "65.21.4.12 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample",
        "hetzner ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQexample",
        "|1|JfKTdBh7rNbXkVAQCRp4OQoPfmI=|USECr3SWf1JUPsms5AqfD5QfxkM= ssh-ed25519 AAAAexample",
        "[box.example.com]:2222 ssh-ed25519 AAAAexample",
        "box.example.com ssh-ed25519 AAAAexample",
        "@cert-authority *.corp ssh-ed25519 AAAAexample",
        "@revoked old.example.com ssh-ed25519 AAAAexample",
        "*.lan ssh-ed25519 AAAAexample",
        "10.0.0.7 ecdsa-sha2-nistp256 AAAAexample",
        "[fe80::1]:22 ssh-ed25519 AAAAexample",
        "example.org ssh-rsa AAAAexample",
        "",
      ].join("\n"),
    });
    expect(sshHostsIn(SSH, [], files)).toEqual([
      { alias: "hetzner", hostName: "65.21.4.12", from: "config" },
      { alias: "example.org", from: "known_hosts" },
      { alias: "box.example.com", port: 2222, from: "known_hosts" },
      { alias: "10.0.0.7", from: "known_hosts" },
      { alias: "fe80::1", port: 22, from: "known_hosts" },
    ]);
  });

  it("leaves out the computers already added over ssh, by their login or the address they last dialled from", () => {
    const files = folder({
      [`${SSH}/config`]: "Host hetzner\n  HostName 65.21.4.12\n  User root\nHost attic\n  HostName 192.168.1.40\nHost pi",
      [`${SSH}/known_hosts`]: "10.0.0.7 ssh-ed25519 AAAAexample\nbox.example.com ssh-ed25519 AAAAexample\n[spare]:2200 ssh-ed25519 AAAAexample",
    });
    const places = [
      { road: { ssh: "root@65.21.4.12" } },
      { road: { ssh: "attic" } },
      { road: { from: "10.0.0.7" } },
      { road: { ssh: "lena@spare:2200" } },
      {},
    ];
    expect(sshHostsIn(SSH, places, files)).toEqual([
      { alias: "pi", from: "config" },
      { alias: "box.example.com", from: "known_hosts" },
    ]);
  });

  it("matches an Include glob in time linear in the name, whatever the stars", () => {
    const files = folder({
      [`${SSH}/config`]: "Include config.d/*****x\nInclude config.d/*.c?nf\nHost after",
      [`${SSH}/config.d/${"a".repeat(205)}`]: "Host never",
      [`${SSH}/config.d/${"a".repeat(255)}`]: "Host never2",
      [`${SSH}/config.d/box.conf`]: "Host box",
      [`${SSH}/config.d/abcx`]: "Host starred",
    });
    const started = performance.now();
    expect(sshHostsIn(SSH, [], files).map(h => h.alias)).toEqual(["starred", "box", "after"]);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("takes a port from 1 to 65535 in either file and skips a line that names any other, keeping the rest of the list", () => {
    const files = folder({
      [`${SSH}/config`]: "Host zero\n  Port 0\n  Port 2200\nHost huge\n  Port 70000\nHost fine\n  Port 65535",
      [`${SSH}/known_hosts`]: [
        "[box.example.com]:99999 ssh-ed25519 AAAAexample",
        "[other]:0 ssh-ed25519 AAAAexample",
        `[big]:${"9".repeat(20)} ssh-ed25519 AAAAexample`,
        "[ok]:2200 ssh-ed25519 AAAAexample",
        "plain ssh-ed25519 AAAAexample",
      ].join("\n"),
    });
    const hosts = sshHostsIn(SSH, [], files);
    expect(hosts).toEqual([
      { alias: "zero", port: 2200, from: "config" },
      { alias: "huge", from: "config" },
      { alias: "fine", port: 65535, from: "config" },
      { alias: "ok", port: 2200, from: "known_hosts" },
      { alias: "plain", from: "known_hosts" },
    ]);
    expect(SshHostSuggestion.array().safeParse(hosts).success).toBe(true);
  });

  it("hides the git forges and their subdomains from both files, by alias or by HostName", () => {
    const files = folder({
      [`${SSH}/config`]: "Host github.com\nHost gh\n  HostName github.com\nHost work\n  HostName ssh.dev.azure.com\nHost box\n  HostName 10.0.0.9",
      [`${SSH}/known_hosts`]: [
        "gitlab.com ssh-ed25519 AAAAexample",
        "git.sr.ht ssh-ed25519 AAAAexample",
        "codeberg.org ssh-ed25519 AAAAexample",
        "altssh.bitbucket.org ssh-ed25519 AAAAexample",
        "[vs-ssh.visualstudio.com]:22 ssh-ed25519 AAAAexample",
        "notgithub.com ssh-ed25519 AAAAexample",
        "github.com.example.net ssh-ed25519 AAAAexample",
      ].join("\n"),
    });
    expect(sshHostsIn(SSH, [], files).map(h => h.alias)).toEqual(["box", "notgithub.com", "github.com.example.net"]);
    for (const host of GIT_FORGE_HOSTS) expect(isGitForge(host)).toBe(true);
    expect(isGitForge("eu.gitlab.com")).toBe(true);
    expect(isGitForge("GitHub.com")).toBe(true);
    expect(isGitForge("mygithub.com")).toBe(false);
  });

  it("answers none when the ssh folder holds neither file", () => {
    expect(sshHostsIn(SSH, [], folder({}))).toEqual([]);
  });
});
