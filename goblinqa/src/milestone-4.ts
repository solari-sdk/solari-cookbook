import { parseAuthorizedInput } from "./goblin/cli.js"
import { runSwarm } from "./goblin/swarm.js"

const { targetUrl, goal } = parseAuthorizedInput(4)
const report = await runSwarm({ url: targetUrl, goal, milestone: 4 })
console.log(JSON.stringify(report, null, 2))
if (report.runtimeFailures.length > 0) process.exitCode = 1
