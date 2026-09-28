// SPDX-License-Identifier: AGPL-3.0-only
// What bringing work back answers with. Work leaves a workspace through git
// alone: the daemon inside it pushes the branch the agent made and opens the
// pull request through the git host's own signed-in command line, and these
// are the shapes those two frames and the verb above them carry.
import { z } from "zod";

/** Where a pull request stands, in the three words every host of them has. */
export const PullRequestState = z.enum(["open", "merged", "closed"]);
export type PullRequestState = z.infer<typeof PullRequestState>;

/** One pull request as its host's command line answered with it, read off that command's JSON. */
export const PullRequest = z.object({
  number: z.number().int(),
  url: z.string(),
  state: PullRequestState,
  /** The git host it lives on, as the remote's url names it. */
  host: z.string(),
});
export type PullRequest = z.infer<typeof PullRequest>;

/** What the push carried: the branch, the branch it is measured against, where it went, how many commits it has
 * that the base lacks, how many changes were left uncommitted inside the workspace, and git's own diffstat. */
export const GitPushReply = z.object({
  branch: z.string(),
  base: z.string(),
  remote: z.string(),
  ahead: z.number().int(),
  uncommitted: z.number().int(),
  stat: z.array(z.string()),
});
export type GitPushReply = z.infer<typeof GitPushReply>;

/** The branch's pull request, and whether this call is what opened it. */
export const GitPrReply = z.object({ pr: PullRequest, created: z.boolean() });
export type GitPrReply = z.infer<typeof GitPrReply>;

/** The branch's pull request as it stands, absent where its host knows none. */
export const GitPrStateReply = z.object({ pr: PullRequest.optional() });
export type GitPrStateReply = z.infer<typeof GitPrStateReply>;

/** What a bring back answers: the push, then the pull request where a host command line was there to open one. The
 * two halves are reported apart, since the push has landed by the time the pull request half runs: the note is why
 * there is no pull request beside a push that landed and no failure, and the refusal is the pull request half's own
 * failure, which the push above it still stands under. */
export const BringBackResult = z.object({
  branch: z.string(),
  base: z.string(),
  ahead: z.number().int(),
  uncommitted: z.number().int(),
  stat: z.array(z.string()),
  pr: PullRequest.optional(),
  note: z.string().optional(),
  refused: z.string().optional(),
});
export type BringBackResult = z.infer<typeof BringBackResult>;
