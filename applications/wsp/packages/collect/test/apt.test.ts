// SPDX-License-Identifier: AGPL-3.0-only
// The apt reader: which of a Linux computer's packages are a person's own
// choice, measured against the rule the base image's own 300-odd packages need
// to be told apart from the handful somebody typed.
import { describe, expect, it } from "vitest";
import { aptPackages, aptSizes, parseAptManual, parseDpkgFields } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

const MANUAL = ["direnv", "fd-find", "fish", "fonts-dejavu-core", "libpq5", "lsb-release", "sudo", "tmux", "ubuntu-minimal"].join("\n");

const PRIORITY = [
  "direnv optional",
  "fd-find optional",
  "fish optional",
  "fonts-dejavu-core extra",
  "libpq5 optional",
  "lsb-release optional",
  "sudo optional",
  "tmux optional",
  "ubuntu-minimal important",
  "",
].join("\n");

const SIZES = ["direnv 9000", "fd-find 3000", "fish 20000", "tmux 1100", ""].join("\n");

/** dpkg's own file lists: a package installed for one architecture is named with it. */
const LISTS = {
  "/var/lib/dpkg/info/direnv:amd64.list": "/usr/bin/direnv\n/usr/share/doc/direnv/copyright\n",
  "/var/lib/dpkg/info/fd-find.list": "/usr/bin/fdfind\n",
  "/var/lib/dpkg/info/fish.list": "/usr/share/fish/config.fish\n/usr/bin/fish\n",
  "/var/lib/dpkg/info/fonts-dejavu-core.list": "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf\n",
  "/var/lib/dpkg/info/libpq5:amd64.list": "/usr/lib/x86_64-linux-gnu/libpq.so.5.16\n",
  "/var/lib/dpkg/info/lsb-release.list": "/usr/bin/lsb_release\n",
  "/var/lib/dpkg/info/sudo.list": "/usr/bin/sudo\n",
  "/var/lib/dpkg/info/tmux.list": "/usr/bin/tmux\n",
  "/var/lib/dpkg/info/ubuntu-minimal.list": "/usr/share/doc/ubuntu-minimal/copyright\n",
};

const EXEC = {
  "apt-mark showmanual": MANUAL,
  "dpkg-query -Wf ${Package} ${Priority}\n": PRIORITY,
  "dpkg-query -Wf ${Package} ${Installed-Size}\n": SIZES,
};

const ubuntu = (over: Record<string, string> = {}) => fakeHost({ platform: "linux", which: ["apt-mark", "dpkg-query"], files: LISTS, exec: { ...EXEC, ...over } });

describe("the apt reader", () => {
  it("reads a package and its field from dpkg-query, dropping a line that names no value", () => {
    expect(parseDpkgFields("direnv optional\nfish extra\nbroken\n\n")).toEqual(new Map([["direnv", "optional"], ["fish", "extra"]]));
  });

  it("reads the manual list as names, blank lines dropped", () => {
    expect(parseAptManual("direnv\n\nfish\n")).toEqual(["direnv", "fish"]);
  });

  it("keeps the packages a person chose and drops the distro's own", async () => {
    // What the catalog or another rung already carries is dropped by the caller, so tmux and fd-find are in this list.
    expect((await aptPackages(ubuntu())).map(p => p.name)).toEqual(["direnv", "fd-find", "fish", "tmux"]);
  });

  it("drops a package the base image's priority says nobody chose", async () => {
    // ubuntu-minimal is marked manual on every Ubuntu and is the image itself, not a choice.
    expect((await aptPackages(ubuntu())).map(p => p.name)).not.toContain("ubuntu-minimal");
  });

  it("drops a package that ships no command under /usr/bin or /bin: a library or a font is not a tool to bring", async () => {
    const names = (await aptPackages(ubuntu())).map(p => p.name);
    expect(names).not.toContain("libpq5");
    expect(names).not.toContain("fonts-dejavu-core");
  });

  it("drops the packages an installer marks manual that nobody picks", async () => {
    const names = (await aptPackages(ubuntu())).map(p => p.name);
    expect(names).not.toContain("sudo");
    expect(names).not.toContain("lsb-release");
  });

  it("reads one directory and two dpkg-query runs, never a dpkg -L per package", async () => {
    const host = ubuntu();
    await aptPackages(host);
    expect(host.calls.filter(c => c.startsWith("run dpkg-query"))).toHaveLength(1);
    expect(host.calls.filter(c => c.includes("dpkg -L"))).toEqual([]);
    // Only the packages that got as far as the file test are read.
    expect(host.calls.filter(c => c.startsWith("lines "))).toEqual([
      "lines /var/lib/dpkg/info/direnv:amd64.list",
      "lines /var/lib/dpkg/info/fd-find.list",
      "lines /var/lib/dpkg/info/fish.list",
      "lines /var/lib/dpkg/info/fonts-dejavu-core.list",
      "lines /var/lib/dpkg/info/libpq5:amd64.list",
      "lines /var/lib/dpkg/info/tmux.list",
    ]);
  });

  it("says nothing when apt-mark answers nothing", async () => {
    expect(await aptPackages(ubuntu({ "apt-mark showmanual": "" }))).toEqual([]);
  });

  it("reads each package's size from dpkg's own record, in bytes", async () => {
    expect(await aptSizes(ubuntu(), ["direnv", "fish"])).toEqual(new Map([["direnv", 9000 * 1024], ["fish", 20000 * 1024]]));
  });

  it("asks dpkg nothing when no package needs a size", async () => {
    const host = ubuntu();
    expect(await aptSizes(host, [])).toEqual(new Map());
    expect(host.calls).toEqual([]);
  });
});
