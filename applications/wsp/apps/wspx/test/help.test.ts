import { describe, expect, it } from "vitest";
import { HELP } from "../src/main.js";

describe("wspx --help", () => {
  it("lists every subcommand", () => {
    for (const cmd of ["golden build", "new", "ls", "send", "dotfiles", "nap", "wake", "upgrade", "rm", "reap", "demo"]) {
      expect(HELP).toContain(cmd);
    }
  });
});
