// SPDX-License-Identifier: AGPL-3.0-only
// The agents the catalog knows, one module each, in the order every list of
// them keeps. Adding an agent is its module and its line here.
import type { AgentEntry } from "../catalog.js";
import { AMP } from "./amp.js";
import { CLAUDE } from "./claude.js";
import { CODEX } from "./codex.js";
import { CRUSH } from "./crush.js";
import { GEMINI } from "./gemini.js";
import { GOOSE } from "./goose.js";
import { HERMES_AGENT } from "./hermes.js";
import { OPENCODE } from "./opencode.js";
import { PI } from "./pi.js";
import { QWEN } from "./qwen.js";

export const AGENT_MODULES: readonly AgentEntry[] = [CLAUDE, CODEX, GEMINI, OPENCODE, PI, HERMES_AGENT, CRUSH, QWEN, GOOSE, AMP];
