// pnpm run new <task> [--minutes N] [--setup N]
// Creates an Interview and prints the Candidate's and the Reviewer's links.
import { parseArgs } from "node:util"
import { flow } from "./app.ts"
import { config } from "./config.ts"
import { listTasks } from "./tasks.ts"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { minutes: { type: "string" }, setup: { type: "string" } },
})

const [taskName] = positionals
if (!taskName) {
  console.error(`Usage: pnpm run new <task> [--minutes N] [--setup N]\nTasks: ${listTasks().join(", ")}`)
  process.exit(1)
}

const iv = flow.create(taskName, {
  workMinutes: values.minutes ? Number(values.minutes) : undefined,
  setupMinutes: values.setup ? Number(values.setup) : undefined,
})
const base = config.publicUrl
console.log(`Interview ${iv.id}: ${iv.task}, ${iv.setupMinutes} min setup + ${iv.workMinutes} min work`)
console.log(`Candidate link (send this): ${base}/c/${iv.candidateToken}`)
console.log(`Reviewer link (keep this):  ${base}/r/${iv.reviewerToken}`)
