import { parseAuthorizedInput } from "./goblin/cli.js"
import { runSwarm } from "./goblin/swarm.js"

const { targetUrl, goal } = parseAuthorizedInput(6)
const report = await runSwarm({
  url: targetUrl,
  goal,
  milestone: 6,
  goblinCount: Number(process.env.GOBLIN_COUNT || "5"),
  allowLargeRun: process.env.GOBLINQA_LARGE_RUN_AUTHORIZED === "true",
})
console.log(JSON.stringify(report, null, 2))
if (report.runtimeFailures.length > 0) process.exitCode = 1
