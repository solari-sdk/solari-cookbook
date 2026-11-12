/**
 * Long-form text for `--explain <id>`.
 *
 * design.md §6.7 requires the issue #25 session-lifetime finding to be
 * available on demand and never re-verified at runtime. Holding these as data
 * keeps that promise: `--explain` reads text and performs no I/O and no API
 * call.
 *
 * An entry may exist before its check does. `session-liveness` is present now
 * because the finding it describes is already verified (findings F31, and
 * issue #25); the check itself lands in module 13.
 */

export const EXPLANATIONS: Readonly<Record<string, string>> = {
  "session-liveness": [
    "session-liveness — why this check is structural, not a reproduction",
    "",
    "Cookbook issue #25 reports that browser sessions end roughly ten minutes",
    "after creation regardless of activity, while GET /sessions/:id keeps",
    "returning 200 {\"status\":\"active\"}. Six measured sessions lasted 604-616",
    "seconds against a documented expiresAt of createdAt + 5h on the Starter",
    "plan.",
    "",
    "solari-doctor does not reproduce that timeline. Doing so would cost ten",
    "minutes of waiting on every run, which fails design principle 2 (cheap by",
    "default). Presenting a documented finding as a live check would also claim",
    "more than the run actually observed.",
    "",
    "What the check does instead is verify that this tool derives liveness from",
    "the connection rather than the status field: it ends a session and confirms",
    "isConnected() reports false, that the disconnected event fires, and that a",
    "subsequent page call throws. All three signals were confirmed against the",
    "live API.",
    "",
    "Practical consequence: do not trust the status field to tell you a session",
    "is alive. An agent that schedules work on the basis of status will keep",
    "sending it to a session that no longer exists.",
  ].join("\n"),
};
