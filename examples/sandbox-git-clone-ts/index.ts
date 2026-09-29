import { SolariClient } from "@solarisdk/sdk"

const [repositoryUrl, command] = process.argv.slice(2)

if (!repositoryUrl || !command) {
  console.error("Usage: npm start -- <repository-url> <command>")
  process.exit(1)
}

const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
const sandbox = await pt.sandboxes.create({
  template: "base",
  timeoutMs: 5 * 60_000,
})
console.log("sandbox:", sandbox.sandboxId)

try {
  await sandbox.connect()

  await sandbox.git.clone(repositoryUrl, {
    path: "/work/repo",
    depth: 1,
  })

  const status = await sandbox.git.status("/work/repo")
  console.log("branch:", status.branch || "(detached)")
  console.log("state :", status.clean ? "clean" : "dirty")
  console.log("ahead :", status.ahead)
  console.log("behind:", status.behind)

  const result = await sandbox.commands.run("sh", {
    args: ["-lc", command],
    cwd: "/work/repo",
    onStdout: (data) => process.stdout.write(data),
    onStderr: (data) => process.stderr.write(data),
  })
  console.log("exit:", result.exitCode)
  process.exitCode = result.exitCode
} finally {
  await sandbox.kill()
}
