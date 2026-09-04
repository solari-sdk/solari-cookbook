/**
 * Standalone repo mode — clone a repo into a Solari sandbox, detect the stack,
 * install, build, start, and hand back a live preview URL.
 *
 * Usage: npx tsx repo-mode.ts <repo-url>
 */
import { SolariClient } from "@solarisdk/sdk"
import * as readline from "readline"

const REPO_URL = process.argv[2]
if (!REPO_URL) {
  console.error("Usage: npx tsx repo-mode.ts <repo-url>")
  process.exit(1)
}

const WALL_CLOCK_CAP_MS = 15 * 60_000 // 15 min hard cap

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

async function main() {
  const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })

  log("Creating sandbox...")
  const sandbox = await pt.sandboxes.create({
    template: "base",
    timeoutMs: 5 * 60_000,
  })
  log(`Sandbox created: ${sandbox.sandboxId}`)

  // Hard wall-clock cap — kill regardless of activity
  const capTimer = setTimeout(async () => {
    log("WALL CLOCK CAP REACHED — killing sandbox")
    await sandbox.kill()
    process.exit(1)
  }, WALL_CLOCK_CAP_MS)

  try {
    await sandbox.connect()
    log("Connected to sandbox")

    // Clone
    log(`Cloning ${REPO_URL}...`)
    await sandbox.commands.run("sh", {
      args: ["-c", `git clone --depth 1 ${REPO_URL} /tmp/repo 2>&1`],
    })
    log("Clone complete")

    // Detect package manager
    const lockfiles = await sandbox.commands.run("sh", {
      args: ["-c", "ls /tmp/repo/package-lock.json /tmp/repo/pnpm-lock.yaml /tmp/repo/yarn.lock /tmp/repo/bun.lockb 2>/dev/null || true"],
    })
    const lockOut = lockfiles.stdout.trim()
    let pkgManager = "npm"
    if (lockOut.includes("bun.lockb")) pkgManager = "bun"
    else if (lockOut.includes("pnpm-lock.yaml")) pkgManager = "pnpm"
    else if (lockOut.includes("yarn.lock")) pkgManager = "yarn"
    log(`Package manager: ${pkgManager}`)

    // Detect framework from package.json
    const pkgJson = await sandbox.commands.run("sh", {
      args: ["-c", "cat /tmp/repo/package.json 2>/dev/null || echo '{}'"],
    })
    let framework = "unknown"
    let port = 3000
    const deps = pkgJson.stdout
    if (deps.includes('"next"')) { framework = "Next.js"; port = 3000 }
    else if (deps.includes('"vite"')) { framework = "Vite"; port = 5173 }
    else if (deps.includes('"react-scripts"')) { framework = "CRA"; port = 3000 }
    else if (deps.includes('"@remix-run"')) { framework = "Remix"; port = 3000 }
    else if (deps.includes('"astro"')) { framework = "Astro"; port = 4321 }
    else if (deps.includes('"express"') || deps.includes('"fastify"')) { framework = "Node"; port = 3000 }
    log(`Framework: ${framework} (default port: ${port})`)

    // Check for static index.html with no build step
    const hasBuildScript = await sandbox.commands.run("sh", {
      args: ["-c", 'grep -q \'"build"\' /tmp/repo/package.json 2>/dev/null && echo "yes" || echo "no"'],
    })
    const hasIndexHtml = await sandbox.commands.run("sh", {
      args: ["-c", "test -f /tmp/repo/index.html && echo 'yes' || echo 'no'"],
    })
    const isStatic = hasBuildScript.stdout.trim() === "no" && hasIndexHtml.stdout.trim() === "yes"

    if (isStatic) {
      log("Static index.html detected, no build step needed")
    } else {
      // Install
      const installCmd = pkgManager === "yarn" ? "yarn install --frozen-lockfile" :
        pkgManager === "pnpm" ? "pnpm install --frozen-lockfile" :
        pkgManager === "bun" ? "bun install --frozen-lockfile" :
        "npm ci"
      log(`Installing dependencies: ${installCmd}`)
      const installResult = await sandbox.commands.run("sh", {
        args: ["-c", `cd /tmp/repo && ${installCmd} 2>&1`],
      })
      if (installResult.exitCode !== 0) {
        log("INSTALL FAILED")
        console.log(installResult.stdout)
        console.error(installResult.stderr)
        return
      }
      log("Install complete")

      // Build
      log("Building...")
      const buildResult = await sandbox.commands.run("sh", {
        args: ["-c", "cd /tmp/repo && npm run build 2>&1"],
      })
      if (buildResult.exitCode !== 0) {
        log("BUILD FAILED")
        console.log(buildResult.stdout)
        console.error(buildResult.stderr)
        return
      }
      log("Build complete")
    }

    // Start dev server
    log(`Starting server on port ${port}...`)
    await sandbox.commands.run("sh", {
      args: ["-c", `cd /tmp/repo && nohup ${pkgManager} run start -- --host 0.0.0.0 --port ${port} > /tmp/server.log 2>&1 &`],
    })

    // Get preview URL
    const { url } = await sandbox.previewUrl(port)
    log(`Preview URL: ${url}`)

    // Wait for server to be ready
    log("Waiting for server to respond...")
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const res = await fetch(url)
        if (res.ok) {
          log("Server is ready!")
          break
        }
      } catch {
        // server not ready yet
      }
    }

    console.log(`\n========================================`)
    console.log(`Preview URL: ${url}`)
    console.log(`========================================\n`)
    console.log(`Press Enter to tear down the sandbox...`)

    // Wait for keypress
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    await new Promise<void>((resolve) => rl.question("", () => { rl.close(); resolve() }))

  } finally {
    clearTimeout(capTimer)
    log("Killing sandbox...")
    await sandbox.kill()
    log("Sandbox destroyed")
  }
}

main().catch(async (err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
