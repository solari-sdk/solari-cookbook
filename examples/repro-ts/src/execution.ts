import { SolariClient } from "@solarisdk/sdk"

import type { GitHubRepository } from "./github.js"

const REPOSITORY_PATH = "/work/repo"

export interface ExecuteRepositoryCommandOptions {
  apiKey: string
  repository: GitHubRepository
  command: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function executeRepositoryCommand(
  options: ExecuteRepositoryCommandOptions,
): Promise<number> {
  const { apiKey, repository, command } = options
  const client = new SolariClient({ apiKey })
  const sandbox = await client.sandboxes.create({
    template: "base",
    timeoutMs: 5 * 60_000,
  })
  let operationFailed = false

  try {
    console.log(`Sandbox: ${sandbox.sandboxId}`)
    await sandbox.connect()

    console.log(`Cloning ${repository.url} into ${REPOSITORY_PATH}...`)
    await sandbox.git.clone(repository.url, {
      path: REPOSITORY_PATH,
      depth: 1,
    })

    const status = await sandbox.git.status(REPOSITORY_PATH)
    const branch = status.branch || (status.detached ? "detached HEAD" : "unavailable")

    console.log("Repository status:")
    console.log(`  repository: ${repository.slug}`)
    console.log(`  branch: ${branch}`)
    console.log(`  working tree: ${status.clean ? "clean" : "dirty"}`)
    console.log(`  ahead/behind: ${status.ahead}/${status.behind}`)
    console.log(`\nRunning: ${command}\n`)

    const startedAt = process.hrtime.bigint()
    const result = await sandbox.commands.run("sh", {
      args: ["-lc", command],
      cwd: REPOSITORY_PATH,
      onStdout: (data) => process.stdout.write(data),
      onStderr: (data) => process.stderr.write(data),
    })
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
    const commandFailed = result.exitCode !== 0
    operationFailed = commandFailed
    const finalStatus = commandFailed ? "FAILED" : "SUCCESS"

    console.log("\nRepro summary:")
    console.log(`  repository: ${repository.slug} (${repository.url})`)
    console.log(`  sandbox ID: ${sandbox.sandboxId}`)
    console.log(`  branch: ${branch}`)
    console.log(`  command: ${command}`)
    console.log(`  exit code: ${result.exitCode}`)
    console.log(`  elapsed: ${(elapsedMs / 1_000).toFixed(2)}s`)
    console.log(`  status: ${finalStatus}`)

    return commandFailed ? 1 : 0
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    try {
      await sandbox.kill()
      console.log(`Destroyed sandbox ${sandbox.sandboxId}.`)
    } catch (error) {
      const message = `Failed to destroy sandbox ${sandbox.sandboxId}: ${errorMessage(error)}`
      if (operationFailed) {
        console.error(message)
      } else {
        throw new Error(message, { cause: error })
      }
    }
  }
}
