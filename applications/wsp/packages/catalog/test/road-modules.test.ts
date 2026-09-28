// SPDX-License-Identifier: AGPL-3.0-only
// What a road says about reading a row back off a machine: whether the road
// has a presence test of its own, and which directories it links the commands
// it installs into. Both are read by the recipe job and by the doctor through
// one planned step, so a computers row and a doctor line cannot disagree about
// a tool. And where a job's managers install: under the machine's home for an
// image, under a folder of wsp's own for a computer somebody owns.
import { describe, expect, it } from "vitest";
import { PNPM_HOME } from "@wsp/protocol";
import { APT_BIN, BREW_PREFIX, CARGO_BIN, FROM_A_READABLE_DIR, GUEST_HOME, HOME_BIN, INSTALL_HOMES, LOCAL_BIN, ROADS, ROAD_MODULES, TOOL_PREFIX, asLinuxbrew, catalogToolFor, installEnv, installHomes, roadModule, type InstallHomes, type InstallRoad } from "../src/index.js";

const present = (road: InstallRoad, bin = "x"): string | undefined => roadModule(road).present?.(road, bin);
const bins = (road: InstallRoad, homes?: InstallHomes): readonly string[] => roadModule(road).bins(road, homes);
const check = (road: InstallRoad, bin = "x"): string | undefined => roadModule(road).check?.(road, bin);

describe("a road's own presence read", () => {
  it("is the prefix's link for a core formula and the link or the command for a tap formula, and no other road has one", () => {
    // A core formula is never read by its name: node comes from the base stage's own installer and gh from the
    // release road, both under the name a formula of the same name would carry, so a command read would call a box
    // green for a Homebrew row Homebrew never installed. That is the row this rule was filed on.
    expect(present({ road: "brew", formula: "go" })).toBe(`test -e ${BREW_PREFIX}/opt/go`);
    expect(present({ road: "brew", formula: "felixkratz/formulae/sketchybar" })).toBe(`test -e ${BREW_PREFIX}/opt/sketchybar || command -v 'sketchybar' >/dev/null 2>&1`);
    // Every other road puts its own command on PATH under the name the row carries, so the command is the read and
    // the step's own check is what runs after an install.
    for (const road of ROADS.filter(r => r !== "brew")) expect(ROAD_MODULES[road].present, road).toBeUndefined();
  });
});

describe("a road's own check", () => {
  it("is Homebrew's own list for a formula, on the one linuxbrew line, and no other road has one", () => {
    // The read after an install, which runs brew and so cannot be answered inside a workspace; a row read by a
    // command written beside it reads whatever that command said on the day it was written.
    expect(check({ road: "brew", formula: "bat" })).toBe(asLinuxbrew("list --versions bat"));
    expect(check({ road: "brew", formula: "bat" })).toContain(FROM_A_READABLE_DIR);
    for (const road of ROADS.filter(r => r !== "brew")) expect(ROAD_MODULES[road].check, road).toBeUndefined();
  });
});

describe("the directories a road links its commands into", () => {
  it("is answered by every road, as absolute paths, and is not the visibility list", () => {
    expect(Object.keys(ROAD_MODULES).sort()).toEqual([...ROADS].sort());
    for (const road of ROADS) {
      const module = ROAD_MODULES[road];
      // The script road alone answers off its own row, since no two of its installers link into one directory.
      if (road !== "script") expect(module.bins({ road } as never).length, road).toBeGreaterThan(0);
      for (const dir of module.bins({ road, script: "x" } as never)) expect(dir.startsWith("/"), `${road} links into ${dir}, which is no absolute path`).toBe(true);
    }
    // Homebrew's prefix is where a formula lands, and the road to /usr/local/bin is what a tap formula with no
    // Linux bottle takes; its roots are the trees a workspace has to see, which is the coarser question.
    expect(bins({ road: "brew", formula: "go" })).toEqual([`${BREW_PREFIX}/bin`, `${BREW_PREFIX}/sbin`, LOCAL_BIN]);
    expect(bins({ road: "apt", packages: ["ffmpeg"] })).toEqual([APT_BIN, "/usr/sbin", "/bin", "/sbin"]);
    expect(bins({ road: "npm", package: "pnpm" })).toEqual([LOCAL_BIN]);
    expect(bins({ road: "release", repo: "cli/cli" })).toEqual([LOCAL_BIN]);
    expect(bins({ road: "pnpm", package: "wrangler" })).toEqual([PNPM_HOME]);
    expect(bins({ road: "uv", package: "ruff" })).toEqual([HOME_BIN]);
    expect(bins({ road: "cargo", package: "ripgrep" })).toEqual([CARGO_BIN]);
  });

  it("is the script road's own row, and nothing for a script whose row names none", () => {
    expect(bins({ road: "script", script: "curl -o node.tar.gz ...", bins: [LOCAL_BIN] })).toEqual([LOCAL_BIN]);
    expect(bins({ road: "script", script: "apt-get install -y docker-ce" })).toEqual([]);
  });
});

describe("where a job's managers install", () => {
  const homes = installHomes(TOOL_PREFIX);
  const own = installHomes();
  const line = (road: InstallRoad, bin: string, at: InstallHomes): string => {
    const install = roadModule(road).install(road, bin, at);
    if (typeof install !== "string") throw new Error(install.note);
    return install;
  };
  const rustRoad = catalogToolFor("rust")!.installRoad;

  it("is a folder of wsp's own under the prefix, with every command in the one folder the daemon's fixed PATH holds", () => {
    // Under /opt, which the protocol brings into every workspace on that computer through an overlay of its own,
    // so a tool installed here answers inside one while no process in one can write it on the computer itself.
    expect(TOOL_PREFIX).toBe("/opt/wsp");
    for (const name of INSTALL_HOMES) {
      const home = homes[name];
      expect(home.home.startsWith(`${TOOL_PREFIX}/`), name).toBe(true);
      expect(home.bin, name).toBe(LOCAL_BIN);
      // Nothing a manager is told names a directory under the machine's home, which every workspace there writes.
      for (const [knob, value] of Object.entries(home.env)) expect(value.startsWith(`${TOOL_PREFIX}/`) || value === LOCAL_BIN, `${knob}=${value}`).toBe(true);
    }
    // What a step reads its row back by: that one folder for a manager a knob moves, and the manager's own folder
    // ahead of it for one with no such knob, whose commands are linked from there.
    expect(bins({ road: "uv", package: "ruff" }, homes)).toEqual([LOCAL_BIN]);
    expect(bins({ road: "pipx", package: "black" }, homes)).toEqual([LOCAL_BIN]);
    expect(bins({ road: "bun", package: "wrangler" }, homes)).toEqual([LOCAL_BIN]);
    expect(bins({ road: "go", module: "github.com/x/y", version: "v1" }, homes)).toEqual([LOCAL_BIN]);
    expect(bins({ road: "cargo", package: "ripgrep" }, homes)).toEqual([`${TOOL_PREFIX}/cargo/bin`, LOCAL_BIN]);
    expect(bins({ road: "pnpm", package: "wrangler" }, homes)).toEqual([`${TOOL_PREFIX}/pnpm/bin`, LOCAL_BIN]);
  });

  it("is each manager's own folder under the machine's home for a job with no prefix, which is the image", () => {
    expect(bins({ road: "uv", package: "ruff" }, own)).toEqual([HOME_BIN]);
    expect(bins({ road: "pipx", package: "black" }, own)).toEqual([HOME_BIN]);
    expect(bins({ road: "bun", package: "wrangler" }, own)).toEqual([`${GUEST_HOME}/.bun/bin`]);
    expect(bins({ road: "go", module: "github.com/x/y", version: "v1" }, own)).toEqual([`${GUEST_HOME}/go/bin`]);
    expect(bins({ road: "cargo", package: "ripgrep" }, own)).toEqual([CARGO_BIN]);
    expect(bins({ road: "pnpm", package: "wrangler" }, own)).toEqual([PNPM_HOME]);
    // The one knob an image's job exports, the one it has always exported: pnpm has no folder of its own by default.
    expect(installEnv(own)).toEqual({ PNPM_HOME });
    // Nothing is linked and nothing is added to the PATH of a line: an image's scripts read as they did.
    expect(line({ road: "cargo", package: "ripgrep" }, "rg", own)).toBe("cargo install ripgrep --locked");
    expect(line({ road: "pnpm", package: "wrangler" }, "wrangler", own)).toBe("pnpm add -g wrangler");
    expect(line(rustRoad, "cargo", own)).toBe(line(rustRoad, "cargo", homes).split("\nfind ")[0]);
  });

  it("tells each manager its home in the knobs the job exports, every one the manager reads itself", () => {
    expect(installEnv(homes)).toEqual({
      PNPM_HOME: `${TOOL_PREFIX}/pnpm`,
      BUN_INSTALL: `${TOOL_PREFIX}/bun`,
      BUN_INSTALL_BIN: LOCAL_BIN,
      UV_TOOL_DIR: `${TOOL_PREFIX}/uv/tools`,
      UV_TOOL_BIN_DIR: LOCAL_BIN,
      UV_PYTHON_INSTALL_DIR: `${TOOL_PREFIX}/uv/python`,
      PIPX_HOME: `${TOOL_PREFIX}/pipx`,
      PIPX_BIN_DIR: LOCAL_BIN,
      CARGO_HOME: `${TOOL_PREFIX}/cargo`,
      RUSTUP_HOME: `${TOOL_PREFIX}/rustup`,
      GOPATH: `${TOOL_PREFIX}/go`,
      GOBIN: LOCAL_BIN,
    });
  });

  it("links what a manager with no folder knob left in its own folder, and takes the link off again", () => {
    const link = `find ${TOOL_PREFIX}/cargo/bin -maxdepth 1 -type f -perm -u+x -exec ln -sfn {} ${LOCAL_BIN}/ ';'`;
    const cargo = line({ road: "cargo", package: "ripgrep" }, "rg", homes);
    expect(cargo).toContain("cargo install ripgrep --locked");
    expect(cargo.endsWith(link)).toBe(true);
    expect(roadModule({ road: "cargo", package: "ripgrep" } as InstallRoad).uninstall({ road: "cargo", package: "ripgrep" }, "rg", homes)).toEqual({ cmd: `export PATH=${TOOL_PREFIX}/cargo/bin:$PATH; cargo uninstall ripgrep\nrm -f ${LOCAL_BIN}/'rg'` });
    // pnpm refuses to install a global while the folder it links into is off PATH, so its own lines carry it.
    const pnpm = line({ road: "pnpm", package: "wrangler" }, "wrangler", homes);
    expect(pnpm).toContain(`export PATH=${TOOL_PREFIX}/pnpm/bin:$PATH; pnpm add -g wrangler`);
    expect(pnpm.endsWith(`find ${TOOL_PREFIX}/pnpm/bin -maxdepth 1 -type f -perm -u+x -exec ln -sfn {} ${LOCAL_BIN}/ ';'`)).toBe(true);
    // And the version read runs under the same folder, since pnpm refuses that line too.
    expect(roadModule({ road: "pnpm", package: "wrangler" } as InstallRoad).installed!({ road: "pnpm", package: "wrangler" }, "wrangler", homes)).toContain(`export PATH=${TOOL_PREFIX}/pnpm/bin:$PATH; `);
  });

  it("maps the rust row's own command folder to the prefix's and links every command rustup left there", () => {
    // cargo itself stands in the cargo home's own folder, which the fixed PATH does not hold, so no cargo row
    // could run on a computer somebody owns until the toolchain moved under the prefix with its commands linked.
    expect(bins(rustRoad)).toEqual([CARGO_BIN]);
    expect(bins(rustRoad, homes)).toEqual([`${TOOL_PREFIX}/cargo/bin`, LOCAL_BIN]);
    const script = line(rustRoad, "cargo", homes);
    expect(script).toContain("rustup-init");
    expect(script.endsWith(`find ${TOOL_PREFIX}/cargo/bin -maxdepth 1 -type f -perm -u+x -exec ln -sfn {} ${LOCAL_BIN}/ ';'`)).toBe(true);
    // A script row whose own folder no manager keeps is the row's own and stands, with nothing linked.
    const node = catalogToolFor("node")!.installRoad;
    expect(bins(node, homes)).toEqual([LOCAL_BIN]);
    expect(line(node, "node", homes)).toBe(line(node, "node", own));
  });
});
