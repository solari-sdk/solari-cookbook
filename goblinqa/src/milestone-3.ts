import { parseAuthorizedInput } from "./goblin/cli.js"
import { runSwarm } from "./goblin/swarm.js"

const { targetUrl, goal } = parseAuthorizedInput(3)
const report = await runSwarm({ url: targetUrl, goal, milestone: 3 })
console.log(JSON.stringify(report, null, 2))

if (
  report.individualResults.some(
    (result) =>
      result.runtimeError ||
      result.evidence.some((record) => record.screenshot.error) ||
      result.replay.error ||
      result.video.error ||
      result.cleanup.errors.length > 0,
  )
) {
  process.exitCode = 1
}
