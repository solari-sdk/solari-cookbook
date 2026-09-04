export function parseAuthorizedInput(
  milestone: 1 | 2 | 3 | 4 | 5 | 6,
  argv = process.argv.slice(2),
): { targetUrl: string; goal: string } {
  const [targetUrl, goal] = argv
  if (!targetUrl || !goal) {
    throw new Error(`Usage: npm run milestone:${milestone} -- "https://example.com" "Your goal"`)
  }
  const parsedUrl = new URL(targetUrl)
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("The target URL must use http or https.")
  const isReservedSmokeTarget = parsedUrl.hostname === "example.com" || parsedUrl.hostname.endsWith(".example.com")
  if (!isReservedSmokeTarget && process.env.GOBLINQA_AUTHORIZED !== "true") {
    throw new Error("Set GOBLINQA_AUTHORIZED=true only when you own or have permission to test the target.")
  }
  return { targetUrl: parsedUrl.toString(), goal }
}
