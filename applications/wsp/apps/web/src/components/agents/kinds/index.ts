// SPDX-License-Identifier: AGPL-3.0-only
// Every kind the agents manager lists, in tab order. A kind is its module and
// its line here.
import { AGENTS } from "./agents.js";
import type { AnyKind } from "./kind.js";
import { SERVERS } from "./servers.js";
import { SKILLS } from "./skills.js";

export const AGENTS_KINDS: readonly AnyKind[] = [AGENTS, SERVERS, SKILLS];
