// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { SSH_IGNORE_UNKNOWN_DETAIL, detectIdentity } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

const GIT = {
  "git config --global --get user.name": "Dev Person\n",
  "git config --global --get user.email": "dev@example.com\n",
};

describe("identity", () => {
  it("git identity is required and points at the config files that exist", async () => {
    const host = fakeHost({ files: { "~/.gitconfig": 512 }, which: ["git"], exec: GIT });
    const [git] = await detectIdentity(host);
    expect(git).toEqual({
      rung: "identity", id: "identity/git-user", label: "git name and email", paths: ["~/.gitconfig"], bytes: 512, default: "bring", required: true,
    });
  });

  it("a gitconfig with no user set is offered but not required", async () => {
    const host = fakeHost({ files: { "~/.config/git/config": 100 }, which: ["git"] });
    const [git] = await detectIdentity(host);
    expect(git).toMatchObject({ id: "identity/git-user", paths: ["~/.config/git/config"], default: "bring" });
    expect(git?.required).toBeUndefined();
  });

  it("no git and no gitconfig means no identity row", async () => {
    expect(await detectIdentity(fakeHost())).toEqual([]);
  });

  it("signing config travels; the allowed signers file comes with ssh signing", async () => {
    const host = fakeHost({
      files: { "~/.gitconfig": 512, "~/.ssh/allowed_signers": 90 },
      which: ["git"],
      exec: {
        ...GIT,
        "git config --global --get gpg.format": "ssh\n",
        "git config --global --get gpg.ssh.allowedSignersFile": "~/.ssh/allowed_signers\n",
      },
    });
    const rows = await detectIdentity(host);
    expect(rows.find(r => r.id === "identity/git-signing")).toEqual({
      rung: "identity", id: "identity/git-signing", label: "git signing (ssh); the signing key itself stays on this computer", paths: ["~/.ssh/allowed_signers"], bytes: 90, default: "bring",
    });
  });

  it.each([
    ["config", "identity/ssh-config", { default: "bring", paths: ["~/.ssh/config"], detail: SSH_IGNORE_UNKNOWN_DETAIL }],
    ["id_ed25519", "identity/ssh-key/id_ed25519", { default: "skip", reason: "private key, never copied; the machine gets its own key" }],
    ["work_rsa", "identity/ssh-key/work_rsa", { default: "skip" }],
    ["known_hosts", "identity/ssh-known-hosts", { default: "skip", reason: "host entries are rebuilt on first connect" }],
    ["google_compute_known_hosts", "identity/ssh-known-hosts", { default: "skip", paths: ["~/.ssh/google_compute_known_hosts"] }],
  ])("~/.ssh/%s becomes %s", async (name, id, shape) => {
    const host = fakeHost({ files: { [`~/.ssh/${name}`]: 40 } });
    const rows = await detectIdentity(host);
    expect(rows.find(r => r.id === id)).toMatchObject({ rung: "identity", id, bytes: 40, ...shape });
  });

  it("public keys are one required row; authorized_keys and sockets are not keys", async () => {
    const host = fakeHost({
      files: { "~/.ssh/id_ed25519.pub": 100, "~/.ssh/work.pub": 120, "~/.ssh/authorized_keys": 300, "~/.ssh/agent.sock": 0 },
    });
    const rows = await detectIdentity(host);
    expect(rows).toEqual([
      { rung: "identity", id: "identity/ssh-public-keys", label: "SSH public keys (2)", paths: ["~/.ssh/id_ed25519.pub", "~/.ssh/work.pub"], bytes: 220, default: "bring", required: true },
    ]);
  });

  it("a GPG keyring is listed locked off", async () => {
    const rows = await detectIdentity(fakeHost({ files: { "~/.gnupg/pubring.kbx": 5000 } }));
    expect(rows).toEqual([
      { rung: "identity", id: "identity/gpg", label: "GPG keyring", paths: ["~/.gnupg"], bytes: 5000, default: "skip", reason: "GPG keys are never copied" },
    ]);
  });

  it("the ssh config row says what the copy gains as a detail, leaving reason to mean locked off", async () => {
    const [config] = await detectIdentity(fakeHost({ files: { "~/.ssh/config": 900 } }));
    expect(config).toEqual({
      rung: "identity", id: "identity/ssh-config", label: "~/.ssh/config", paths: ["~/.ssh/config"], bytes: 900, default: "bring",
      detail: "copied with IgnoreUnknown at the top, since ssh on the machine does not know every option yours does, and one unknown option would stop it reading the file",
    });
    expect(config?.detail).toBe(SSH_IGNORE_UNKNOWN_DETAIL);
    expect(config?.reason).toBeUndefined();
  });

  it("never reads a file under ~/.ssh", async () => {
    const host = fakeHost({ files: { "~/.ssh/id_ed25519": "PRIVATE", "~/.ssh/config": "Host x" } });
    await detectIdentity(host);
    expect(host.calls.filter(c => c.startsWith("read"))).toEqual([]);
  });
});
