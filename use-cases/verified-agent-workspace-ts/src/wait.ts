export async function waitForHttp(
  url: string,
  attempts = 20,
  delayMs = 750,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow" })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Preview did not become ready: ${detail}`)
}
