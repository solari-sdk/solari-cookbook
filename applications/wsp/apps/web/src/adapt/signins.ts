// SPDX-License-Identifier: AGPL-3.0-only
// The marks the modal's sign-in rows carry: one bundled svg per tool the
// recipe signs in to, drawn the way the agents' marks are, never fetched from
// a favicon service (privacy, offline, one style). The row's tool id is the
// catalog's sign-in row id; a tool without a mark here draws its initials.
// OpenAI's mark is the one the Codex agent's catalog module carries. Each
// file's source and licence is in THIRD_PARTY_NOTICES.
import { agentMark, type AgentMark } from "@wsp/catalog";
import anthropicSvg from "../assets/signins/anthropic.svg?raw";
import githubSvg from "../assets/signins/github.svg?raw";
import googleSvg from "../assets/signins/google.svg?raw";

type SignInSvg = Pick<AgentMark, "svg">;

const GITHUB: SignInSvg = { svg: githubSvg };
const ANTHROPIC: SignInSvg = { svg: anthropicSvg };
const OPENAI: SignInSvg = { svg: agentMark("codex")!.svg };
const GOOGLE: SignInSvg = { svg: googleSvg };

/** By the sign-in row's tool id: the company whose page the sign-in opens. */
const SIGN_IN_MARKS: Readonly<Record<string, SignInSvg>> = {
  gh: GITHUB,
  claude: ANTHROPIC,
  codex: OPENAI,
  gemini: GOOGLE,
  gcloud: GOOGLE,
};

export function signInMark(tool: string): SignInSvg | undefined {
  return SIGN_IN_MARKS[tool];
}
