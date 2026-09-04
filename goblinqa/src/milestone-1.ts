import { parseAuthorizedInput } from "./goblin/cli.js"
import { PERSONAS } from "./goblin/personas.js"
import { runGoblin } from "./goblin/runner.js"

const { targetUrl, goal } = parseAuthorizedInput(1)
const videoPath = process.env.GOBLIN_VIDEO_PATH ?? "artifacts/milestone-1.webm"
const result = await runGoblin({
  url: targetUrl,
  goal,
  persona: PERSONAS[0],
  runId: "milestone-1",
  videoPath,
})
console.log(JSON.stringify({ milestone: 1, ...result }, null, 2))

if (
  result.runtimeError ||
  result.replay.error ||
  result.video.error ||
  result.cleanup.errors.length > 0
) {
  process.exitCode = 1
}
