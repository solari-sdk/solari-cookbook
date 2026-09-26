// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_AGENTS, agentMark } from "@wsp/catalog";

/** Writes each agent's catalog mark as `<id>.svg` under `dir` for the onboarding page to mask its glyphs out of, and
 * answers the ids written. A mask reads only the shape, so every ink becomes one solid fill. */
export function writeGlyphs(dir) {
  mkdirSync(dir, { recursive: true });
  const ids = [];
  for (const agent of CATALOG_AGENTS) {
    const mark = agentMark(agent.id);
    if (mark === undefined) continue;
    const svg = mark.svg.replace(/^<svg(?![^>]*xmlns=)/, '<svg xmlns="http://www.w3.org/2000/svg"').replace(/var\(--ink-\d+\)/g, "#000");
    writeFileSync(join(dir, `${agent.id}.svg`), svg);
    ids.push(agent.id);
  }
  return ids;
}
