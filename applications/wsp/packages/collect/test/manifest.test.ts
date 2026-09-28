// SPDX-License-Identifier: AGPL-3.0-only
import { LOGIN_CHOICES as PROTOCOL_LOGIN_CHOICES } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { LINUX, LOGIN_CHOICES, Manifest, ManifestEntry, RUNGS, parseManifest } from "../src/index.js";

const entry = {
  rung: "identity",
  id: "identity/git-user",
  label: "git name and email",
  paths: ["~/.gitconfig"],
  bytes: 512,
  default: "bring",
  required: true,
};

describe("manifest schema", () => {
  it("a choice sits on a logins row or a consent row, never on a plain one", () => {
    const token = { rung: "agents", id: "agents/mcp/claude/github", label: "github", paths: [], bytes: 0, default: "bring", consent: true, choice: "copy" };
    expect(parseManifest({ entries: [token] }).entries[0]).toMatchObject({ choice: "copy" });
    expect(() => parseManifest({ entries: [{ ...token, consent: undefined }] })).toThrow(/entries\.0\.choice: only a logins row or a consent row carries a choice/);
  });

  it("lists the six rungs in ladder order and the six login choices, which the protocol owns", () => {
    expect(RUNGS).toEqual(["identity", "shell", "toolchains", "tools", "agents", "logins"]);
    expect(LOGIN_CHOICES).toEqual(["copy", "machine", "later", "key", "skip", "token"]);
    expect(LOGIN_CHOICES).toBe(PROTOCOL_LOGIN_CHOICES);
  });

  it("accepts a fresh entry and every recipe field wsp init writes back", () => {
    expect(ManifestEntry.parse(entry)).toEqual(entry);
    const answered = {
      rung: "logins",
      id: "logins/gh",
      label: "GitHub CLI login",
      paths: ["~/.config/gh/hosts.yml"],
      bytes: 200,
      default: "bring",
      group: "CLI logins",
      bring: true,
      choice: "copy",
    };
    expect(ManifestEntry.parse(answered)).toEqual(answered);
  });

  it("a tools row may say whether it runs on Linux", () => {
    const formula = { rung: "tools", id: "tools/brew/mas", label: "mas", group: "Homebrew", paths: [], bytes: 0, default: "skip", reason: "no Linux bottle", linux: "no" };
    expect(ManifestEntry.parse(formula)).toEqual(formula);
    expect(LINUX).toEqual(["yes", "no", "unknown"]);
    const pinned = { rung: "tools", id: "tools/uv/ruff", label: "ruff 0.6.3", group: "uv tools", paths: [], bytes: 0, default: "bring", linux: "yes", version: "0.6.3" };
    expect(ManifestEntry.parse(pinned)).toEqual(pinned);
  });

  it.each([
    ["an unknown rung", { ...entry, rung: "fonts" }],
    ["an empty id", { ...entry, id: "" }],
    ["an id that does not start with its rung", { ...entry, id: "shell/git-user" }],
    ["a default outside bring or skip", { ...entry, default: "maybe" }],
    ["a negative size", { ...entry, bytes: -1 }],
    ["a non-integer size", { ...entry, bytes: 1.5 }],
    ["a choice outside copy, machine, skip", { ...entry, choice: "later" }],
    ["a choice on a row that is not a login", { ...entry, choice: "copy" }],
    ["a required row that defaults to skip", { ...entry, required: true, default: "skip" }],
    ["a linux marker outside yes, no, unknown", { ...entry, rung: "tools", id: "tools/brew/x", linux: "maybe" }],
    ["a linux marker on a row that is not a tool", { ...entry, linux: "yes" }],
    ["a version on a row that is not a tool", { ...entry, version: "1.0.0" }],
    ["a login shell on a row that is not a shell row", { ...entry, login: "zsh" }],
    ["a terminal font on a row that is not a shell row", { ...entry, font: "Hack" }],
    ["sourced files on a row that is not a shell row", { ...entry, sources: ["~/.cargo/env"] }],
  ])("rejects %s", (_name, bad) => {
    expect(ManifestEntry.safeParse(bad).success).toBe(false);
  });

  it("parses the envelope and reports the failing row", () => {
    expect(parseManifest({ entries: [entry] })).toEqual({ entries: [entry] });
    expect(() => parseManifest({ entries: [entry, { ...entry, rung: 3 }] })).toThrow(/entries\.1\.rung/);
    expect(() => parseManifest({ entries: "nope" })).toThrow(/entries/);
    expect(Manifest.safeParse(null).success).toBe(false);
  });

  it("rejects two rows with the same id", () => {
    expect(() => parseManifest({ entries: [entry, entry] })).toThrow(/duplicate id identity\/git-user/);
  });
});
