// SPDX-License-Identifier: AGPL-3.0-only
import type { Size } from "../catalog.js";
import { MIB } from "../roads.js";

/** The file a project keeps its standing instructions for agents in; an agent that reads another one names that too. */
export const AGENTS_MD = "AGENTS.md";
/** What to type inside an agent that has no slash form for a skill: the sentence the wsp skill's description answers.
 * Claude Code reaches a skill by its folder name with a slash, so its own line opens with that and carries this after. */
export const SET_UP_WSP = "set up wsp for me";

/** An agent's bytes are what df moved across its install on the builder: the global, its caches and whatever the
 * installer put under /root; the cache sweep after the stage gives some of it back. */
export const dfSize = (mib: number): Size => ({ bytes: mib * MIB, on: "2026-09-05", method: "df" });

/** What every agent row starts from: its command is its id, it reads the project's AGENTS.md, and its first move is
 * the sentence. */
export const agent = (id: string, size: Size) => ({ id, kind: "agent", bin: id, projectDocs: [AGENTS_MD], firstMove: SET_UP_WSP, size }) as const;

/** The size of an agent no machine has installed. */
export const NOT_MEASURED: Size = { unmeasured: "no machine has installed it yet, so nothing read its bytes" };

/** An agent no golden build has installed yet: no guest ran its road, nobody read where it keeps a project's state,
 * and none of its config travels. */
export const UNMEASURED = {
  source: { sessions: 0, images: 0, road: "unmeasured" },
  projectState: [],
  configPaths: [],
} as const;

