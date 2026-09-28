// SPDX-License-Identifier: AGPL-3.0-only
// This Mac's Homebrew, read once for the Tools screen: what brew knows about
// every installed formula, and how much of the Cellar each one takes.
import { join } from "node:path";
import type { Host } from "@wsp/collect";
import { brewTable, parseDu, type BrewTable } from "@wsp/engine";

export async function readBrewTable(host: Pick<Host, "exec" | "fs">): Promise<BrewTable> {
  if (!(await host.exec.which("brew"))) return new Map();
  const info = await host.exec.run("brew", ["info", "--json=v2", "--installed"]);
  if (info === undefined) throw new Error("brew info failed or timed out");
  const cellar = (await host.exec.run("brew", ["--cellar"]))?.trim();
  if (cellar === undefined || cellar === "") throw new Error("brew --cellar failed");
  const names = await host.fs.list(cellar);
  const du = names.length > 0 ? await host.exec.run("du", ["-sk", ...names.map(n => join(cellar, n))]) : "";
  if (du === undefined) throw new Error("du over the Cellar failed");
  return brewTable(JSON.parse(info), parseDu(du));
}
