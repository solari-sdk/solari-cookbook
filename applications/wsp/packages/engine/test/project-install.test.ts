// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { installScript, projectInstalls } from "../src/project-install.js";

describe("the install a project's own root picks", () => {
  it("is the lockfile's command, in catalog order, one per ecosystem", () => {
    expect(projectInstalls(["package-lock.json", "Cargo.lock"], "/root/wsp")).toEqual([
      { row: "node", command: "npm ci" },
      { row: "rust", command: "cargo fetch --locked" },
    ]);
  });

  it("keeps a store that hard links into the checkout inside the checkout", () => {
    // A store on another btrfs subvolume cannot link across and copies every file instead; a store made a
    // subvolume of its own under the checkout would be dropped by a snapshot of it.
    expect(projectInstalls(["pnpm-lock.yaml"], "/root/wsp")).toEqual([{ row: "node", command: "pnpm install --frozen-lockfile --store-dir '/root/wsp/.pnpm-store'" }]);
    expect(projectInstalls(["pnpm-lock.yaml"], "/root/a folder/wsp")[0]?.command).toContain("'/root/a folder/wsp/.pnpm-store'");
  });

  it("is nothing for a repo no row names an install for", () => {
    expect(projectInstalls(["package.json"], "/root/wsp")).toEqual([]);
  });
});

describe("the line an install runs as", () => {
  it("runs in the project folder and writes its output to a log outside it", () => {
    const script = installScript({ row: "node", command: "npm ci" }, { dir: "/root/wsp", log: "/var/lib/wsp/run/add-pr_1/install.log" });
    expect(script).toBe("mkdir -p '/var/lib/wsp/run/add-pr_1' && cd '/root/wsp' && npm ci >> '/var/lib/wsp/run/add-pr_1/install.log' 2>&1");
    expect(script).not.toContain("/root/wsp/install.log");
  });
});
