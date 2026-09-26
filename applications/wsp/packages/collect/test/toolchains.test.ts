// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { detectToolchains } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

describe("toolchains", () => {
  it("mise brings its config and the global tool-versions", async () => {
    const rows = await detectToolchains(fakeHost({ files: { "~/.config/mise/config.toml": 300, "~/.tool-versions": 40 }, which: ["mise"] }));
    expect(rows).toEqual([
      { rung: "toolchains", id: "toolchains/mise", label: "mise pins", paths: ["~/.config/mise/config.toml", "~/.tool-versions"], bytes: 340, default: "bring" },
    ]);
  });

  it("asdf is recognised by its home dir even when not on PATH", async () => {
    const rows = await detectToolchains(fakeHost({ files: { "~/.asdf/plugins/nodejs/x": 1, "~/.tool-versions": 40 } }));
    expect(rows).toEqual([{ rung: "toolchains", id: "toolchains/asdf", label: "asdf pins", paths: ["~/.tool-versions"], bytes: 40, default: "bring" }]);
  });

  it("fnm names the current node; nvm reads its default alias", async () => {
    const rows = await detectToolchains(fakeHost({
      files: { "~/.nvm/nvm.sh": 1, "~/.nvm/alias/default": "lts/*\n", "~/.node-version": 8 },
      which: ["fnm"],
      exec: { "fnm current": "v22.12.0\n" },
    }));
    expect(rows).toEqual([
      { rung: "toolchains", id: "toolchains/fnm", label: "fnm (node v22.12.0)", paths: ["~/.node-version"], bytes: 8, default: "bring" },
      { rung: "toolchains", id: "toolchains/nvm", label: "nvm (default lts/*)", paths: [], bytes: 0, default: "bring" },
    ]);
  });

  it.each([
    ["pyenv", { "~/.pyenv/version": 6 }, [], "toolchains/pyenv", "pyenv (global python)", ["~/.pyenv/version"]],
    ["uv", { "~/.config/uv/uv.toml": 20, "~/.python-version": 5 }, ["uv"], "toolchains/uv", "uv (python versions)", ["~/.config/uv/uv.toml", "~/.python-version"]],
    ["rustup", { "~/.rustup/settings.toml": 50, "~/.cargo/config.toml": 30 }, [], "toolchains/rustup", "rustup default toolchain", ["~/.rustup/settings.toml", "~/.cargo/config.toml"]],
  ])("%s", async (_name, files, which, id, label, paths) => {
    const rows = await detectToolchains(fakeHost({ files, which }));
    expect(rows).toEqual([{ rung: "toolchains", id, label, paths, bytes: expect.any(Number), default: "bring" }]);
  });

  it("go carries its env file and names the version", async () => {
    const rows = await detectToolchains(fakeHost({ files: { "~/.config/go/env": 12 }, which: ["go"], exec: { "go version": "go version go1.23.1 darwin/arm64\n" } }));
    expect(rows).toEqual([{ rung: "toolchains", id: "toolchains/go", label: "go 1.23.1", paths: ["~/.config/go/env"], bytes: 12, default: "bring" }]);
  });

  it("nothing installed gives no rows", async () => {
    expect(await detectToolchains(fakeHost())).toEqual([]);
  });
});
