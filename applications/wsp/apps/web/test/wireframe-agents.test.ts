// SPDX-License-Identifier: AGPL-3.0-only
// The agents the wireframe fixture names. A screenshot of a screen that names
// agents by their catalog names is read as the product's own, so an invented
// name on one is a claim about an agent wsp cannot open a thread on.
import { describe, expect, it } from "vitest";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { manyAgents } from "./wireframe/agents.js";

describe("the agents the wireframe fixture names", () => {
  it("names only agents the catalog carries, however many the line has to hold", () => {
    const names = CATALOG_AGENTS.map(entry => entry.name);
    const six = manyAgents(6);
    expect(six).toHaveLength(6);
    for (const agent of six) expect(names).toContain(agent.name);
    // One row per agent, so the ids are its own even where a name repeats to fill the line.
    expect(new Set(six.map(agent => agent.id)).size).toBe(6);
  });
});
