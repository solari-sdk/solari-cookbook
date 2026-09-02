import { executeRepositoryCommand } from "./execution.js"
import { fetchGitHubIssue } from "./github-api.js"
import { parseGitHubIssue, parseGitHubRepository } from "./github.js"
import type { ReproductionPlan } from "./plan.js"
import { generateReproductionPlan } from "./planner.js"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function usageError(message: string): Error {
  return new Error(`${message}
Usage:
  npm start -- <github-issue-url> [--json]
  npm start -- <github-repository-url> <command>`)
}

function printList(items: string[]): void {
  if (items.length === 0) {
    console.log("  (none)")
    return
  }
  items.forEach((item, index) => console.log(`  ${index + 1}. ${item}`))
}

function printPlan(plan: ReproductionPlan): void {
  console.log("Reproduction plan")
  console.log("-----------------")
  console.log(`Summary: ${plan.issueSummary}`)
  console.log(`Confidence: ${plan.confidence}`)
  console.log("\nAssumptions:")
  printList(plan.assumptions)
  console.log("\nSetup:")
  printList(plan.setupCommands)
  console.log("\nReproduction:")
  printList(plan.reproductionCommands)
  console.log(`\nExpected evidence:\n  ${plan.expectedEvidence}`)
  console.log("\nSuccess criteria:")
  printList(plan.successCriteria)
  console.log("\nNotes:")
  printList(plan.notes)
}

async function planIssue(issueUrl: string, json: boolean): Promise<number> {
  const reference = parseGitHubIssue(issueUrl)
  const issue = await fetchGitHubIssue(reference, { token: process.env.GITHUB_TOKEN })

  if (!json) {
    console.log("Issue:")
    console.log(`  ${reference.owner}/${reference.repository}#${reference.issueNumber}`)
    console.log(`  ${JSON.stringify(issue.title)}`)
    console.log("\nGenerating reproduction plan...\n")
  }

  const plan = await generateReproductionPlan(issue, {
    model: process.env.REPRO_CODEX_MODEL || undefined,
  })

  if (json) {
    console.log(JSON.stringify(plan, null, 2))
  } else {
    printPlan(plan)
  }

  return 0
}

async function run(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    throw usageError("Missing GitHub URL.")
  }

  if (args.length === 1 || (args.length === 2 && args[1] === "--json")) {
    return planIssue(args[0], args[1] === "--json")
  }

  if (args.length !== 2) {
    throw usageError("Invalid arguments.")
  }

  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) {
    throw new Error("SOLARI_API_KEY is required for sandbox execution.")
  }

  const command = args[1].trim()
  if (!command) {
    throw usageError("Command must not be empty.")
  }

  return executeRepositoryCommand({
    apiKey,
    repository: parseGitHubRepository(args[0]),
    command,
  })
}

try {
  process.exitCode = await run()
} catch (error) {
  console.error(`Repro failed: ${errorMessage(error)}`)
  process.exitCode = 1
}
