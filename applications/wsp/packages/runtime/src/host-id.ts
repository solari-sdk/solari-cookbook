// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { writeOwn } from "@wsp/own-file";

/** Where this install keeps what must never travel with a WSP_HOME: the OS-local config dir. XDG_CONFIG_HOME wins on
 * every platform when set, which is also how the test suite keeps its runs out of the developer's real dir. */
export function localConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") return join(xdg, "wsp");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "wsp");
  return join(homedir(), ".config", "wsp");
}

let warned = false;

/** This machine's name plus a per-install id, made once, so two machines over one state file never read each
 * other's holds as their own. The id is not a secret: a dir that cannot be read or written costs the id, not the run. */
export function hostIdentity(dir = localConfigDir()): string {
  const path = join(dir, "host-id");
  try {
    let id = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (id === "") {
      id = randomBytes(4).toString("hex");
      writeOwn(dir, "host-id", `${id}\n`);
    }
    return `${hostname()}:${id}`;
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn(`host id not kept in ${dir} (${e instanceof Error ? e.message : String(e)}); holds carry the hostname alone`);
    }
    return hostname();
  }
}

/** The host's part of a template name: the per-install id alone, lowercase letters and digits, never the hostname
 * (macOS hostnames carry dots and uppercase and change with the network, and the provider's name rules are not
 * written down). An identity that fell back to the bare hostname is reduced to the same class. */
export function templateHost(hostId: string): string {
  return hostId.slice(hostId.lastIndexOf(":") + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
}
