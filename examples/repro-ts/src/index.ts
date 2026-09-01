import { SolariClient } from "@solarisdk/sdk"

import { parseGitHubRepository } from "./github.js"

const REPOSITORY_PATH = "/work/repo"

function usageError(message: string): Error {
  return new Error(
    `${message}\nUsage: npm start -- <github-repository-url> <command>\n` +
      'Example: npm start -- https://github.com/psf/requests "python3 --version"',
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function run(): Promise<number> {
  const args = process.argv.slice(2)

  if (args.length < 2) {
    throw usageError("Missing repository URL or command.")
  }
  if (args.length > 2) {
    throw usageError("Too many arguments; wrap the command in quotes.")
  }

  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) {
    throw new Error("SOLARI_API_KEY is required. Export it before running Repro.")
  }

  const repository = parseGitHubRepository(args[0])
  const command = args[1].trim()
  if (!command) {
    throw usageError("Command must not be empty.")
  }

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
    const finalStatus = result.exitCode === 0 ? "SUCCESS" : "FAILED"

    console.log("\nRepro summary:")
    console.log(`  repository: ${repository.slug} (${repository.url})`)
    console.log(`  sandbox ID: ${sandbox.sandboxId}`)
    console.log(`  branch: ${branch}`)
    console.log(`  command: ${command}`)
    console.log(`  exit code: ${result.exitCode}`)
    console.log(`  elapsed: ${(elapsedMs / 1_000).toFixed(2)}s`)
    console.log(`  status: ${finalStatus}`)

    return result.exitCode === 0 ? 0 : 1
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

try {
  process.exitCode = await run()
} catch (error) {
  console.error(`Repro failed: ${errorMessage(error)}`)
  process.exitCode = 1
}
