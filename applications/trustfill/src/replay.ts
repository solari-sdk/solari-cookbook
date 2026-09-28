export interface ReplayRequest {
  sessionId: string | null
  getReplayUrl: (sessionId: string) => Promise<string>
  attempts?: number
  delayMs?: number
}

/**
 * Poll for a session replay, and give up quietly.
 *
 * The upload happens asynchronously AFTER the session is released, so the first
 * polls 404 even on a perfectly good recording — that is expected, not an error.
 * Replay is an audit enhancement: a run that filled the questionnaire correctly
 * must not be reported as failed because a recording was slow to appear.
 */
export async function fetchReplayUrl({
  sessionId,
  getReplayUrl,
  attempts = 10,
  delayMs = 3000,
}: ReplayRequest): Promise<string | null> {
  if (!sessionId) return null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const url = await getReplayUrl(sessionId)
      if (url) return url
    } catch {
      // 404 while uploading, or anything else — neither is worth failing over.
    }
    if (attempt < attempts && delayMs) await new Promise((r) => setTimeout(r, delayMs))
  }

  return null
}
