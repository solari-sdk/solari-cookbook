// SPDX-License-Identifier: AGPL-3.0-only
// The ssh config as the machine can parse it. OpenSSH there stops at the first
// keyword it does not know, and the person's computer runs a build that knows
// more of them, so the copy opens with IgnoreUnknown and keeps everything else.
import { describe, expect, it } from "vitest";
import { withIgnoreUnknown } from "../src/index.js";

const PRELUDE = "# wsp: ssh on the machine does not know every option yours does, and one unknown option would stop it reading the file.\nIgnoreUnknown *\n";

describe("withIgnoreUnknown", () => {
  it("puts IgnoreUnknown above everything the file holds and changes nothing else", () => {
    const text = ["# written on the Mac", "Include ~/.ssh/conf.d/*.conf", "", "Host *", "  AddKeysToAgent yes", "  UseKeychain yes", "  IdentityFile ~/.ssh/id_ed25519", "", "Match host bastion", "  User root", ""].join("\n");
    expect(withIgnoreUnknown(text)).toBe(PRELUDE + text);
  });

  it("says who added the line, since the person reads this file on the machine", () => {
    expect(withIgnoreUnknown("Host x\n").split("\n")[0]).toMatch(/^# wsp: /);
  });

  it("leaves a config that has already been through here alone, so a re-import does not stack the line", () => {
    const once = withIgnoreUnknown("Host x\n  User me\n");
    expect(withIgnoreUnknown(once)).toBe(once);
  });

  it("prefaces a config that carries an IgnoreUnknown of its own, rather than trusting it to come first", () => {
    const text = "Host *\n  IgnoreUnknown UseKeychain\n  UseKeychain yes\n";
    expect(withIgnoreUnknown(text)).toBe(PRELUDE + text);
  });

  it("prefaces an empty config", () => {
    expect(withIgnoreUnknown("")).toBe(PRELUDE);
  });
});
