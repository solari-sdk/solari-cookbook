// SPDX-License-Identifier: AGPL-3.0-only
import type { Host } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { SSH_CONFIG_PATH, SSH_IGNORE_UNKNOWN_DETAIL } from "../ssh-config.js";
import { entry, exists, firstLine, found, present, row } from "./common.js";

const GIT_CONFIGS = ["~/.gitconfig", "~/.config/git/config"];

// Names under ~/.ssh that are not keys. Anything else without a .pub suffix is
// treated as a private key and locked off: a false positive costs a greyed row,
// a false negative would copy a key.
const SSH_NOT_KEYS = new Set(["config", "authorized_keys", "environment", "rc", "allowed_signers"]);

const isKnownHosts = (name: string) => name.includes("known_hosts");

async function gitGet(host: Host, key: string): Promise<string | undefined> {
  return firstLine(await host.exec.run("git", ["config", "--global", "--get", key]));
}

export async function detectIdentity(host: Host): Promise<ManifestEntry[]> {
  const rows: (ManifestEntry | undefined)[] = [];
  const hasGit = await host.exec.which("git");
  const configs = await found(host, GIT_CONFIGS);

  const name = hasGit ? await gitGet(host, "user.name") : undefined;
  const email = hasGit ? await gitGet(host, "user.email") : undefined;
  const hasUser = name !== undefined || email !== undefined;
  if (hasUser || configs.paths.length > 0) {
    rows.push(entry({ rung: "identity", id: "identity/git-user", label: "git name and email", ...configs, ...(hasUser ? { required: true } : {}) }));
  }

  if (hasGit) {
    const format = await gitGet(host, "gpg.format");
    const signs = (await gitGet(host, "commit.gpgsign")) ?? (await gitGet(host, "user.signingkey"));
    if (format !== undefined || signs !== undefined) {
      const signers = format === "ssh" ? await gitGet(host, "gpg.ssh.allowedSignersFile") : undefined;
      const f = await found(host, signers === undefined ? [] : [signers]);
      rows.push(entry({
        rung: "identity", id: "identity/git-signing",
        label: `git signing (${format ?? "gpg"}); the signing key itself stays on this computer`, ...f,
      }));
    }
  }

  rows.push(await row(host, { rung: "identity", id: "identity/ssh-config", label: SSH_CONFIG_PATH, paths: [SSH_CONFIG_PATH], detail: SSH_IGNORE_UNKNOWN_DETAIL }));

  const ssh = await host.fs.list(`${host.home}/.ssh`);
  const pubs = ssh.filter(n => n.endsWith(".pub")).map(n => `~/.ssh/${n}`);
  if (pubs.length > 0) {
    rows.push(entry({ rung: "identity", id: "identity/ssh-public-keys", label: `SSH public keys (${pubs.length})`, ...(await found(host, pubs)), required: true }));
  }
  for (const n of ssh) {
    if (n.endsWith(".pub") || SSH_NOT_KEYS.has(n) || isKnownHosts(n) || n.endsWith(".sock")) continue;
    const s = await host.fs.stat(`${host.home}/.ssh/${n}`);
    if (s?.kind !== "file") continue;
    rows.push(entry({
      rung: "identity", id: `identity/ssh-key/${n}`, label: `~/.ssh/${n}`, paths: [`~/.ssh/${n}`], bytes: s.bytes,
      default: "skip", reason: "private key, never copied; the machine gets its own key",
    }));
  }
  rows.push(await row(host, {
    rung: "identity", id: "identity/ssh-known-hosts", label: "~/.ssh/known_hosts", paths: ssh.filter(isKnownHosts).map(n => `~/.ssh/${n}`),
    default: "skip", reason: "host entries are rebuilt on first connect",
  }));

  if (await exists(host, "~/.gnupg")) {
    rows.push(entry({ rung: "identity", id: "identity/gpg", label: "GPG keyring", ...(await found(host, ["~/.gnupg"])), default: "skip", reason: "GPG keys are never copied" }));
  }
  return present(rows);
}
