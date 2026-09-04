/**
 * Repo mode: two phases so the UI can show what we detected and let the
 * user override install/build/start/port before anything actually runs.
 *
 *   detectRepoSession  — create the sandbox, clone, sniff the stack, bail
 *                         out plainly on anything out of scope.
 *   runRepoSession     — install, build, start, expose the port.
 *
 * The same sandbox lives across both phases (held in session-registry),
 * matching "one session = one sandbox: create, run, hold, kill."
 */
import { getSandboxClient, withCapacityRetry } from "./solari"
import { updateSession, addLog, getSession, chargeMinutes, type Session } from "./session-manager"
import { setSandbox, getSandbox, setCapTimer, forget } from "./session-registry"

const REPO_SIZE_CAP_MB = 300
const INSTALL_CAP_MS = 6 * 60_000

function shQuote(url: string): string {
  // The url is attacker-controlled input; it only ever goes through
  // argv (never string-concatenated into a shell we build), except here
  // where the shell needs it as a single git argument. Single-quote and
  // escape embedded single quotes.
  return `'${url.replace(/'/g, `'\\''`)}'`
}

async function run(sandbox: any, script: string) {
  return sandbox.commands.run("sh", { args: ["-c", script] })
}

export function armWallClockCap(session: Session, sandbox: any) {
  const msLeft = session.expiresAt.getTime() - Date.now()
  const timer = setTimeout(async () => {
    await addLog(session.id, "error", `Wall-clock cap reached — tearing down`, "timeout")
    try {
      await sandbox.kill()
    } catch {
      /* already dead */
    }
    forget(session.id)
    await updateSession(session.id, { status: "killed", errorSummary: "Session hit its wall-clock cap" })
    await chargeMinutes(session)
  }, Math.max(0, msLeft))
  setCapTimer(session.id, timer)
}

function summarizeFailure(output: string): string {
  if (/EBADENGINE|engine "node"|unsupported engine/i.test(output)) {
    return "Node version mismatch — this repo's package.json engines field wants a different Node than the sandbox has"
  }
  if (/ENOENT.*\.env|is not defined|process\.env\.[A-Z0-9_]+.*undefined/i.test(output)) {
    return "Looks like a required environment variable is missing — check .env.example"
  }
  if (/ECONNREFUSED.*(5432|3306|6379|27017)/.test(output)) {
    return "The app tried to reach a database that isn't there"
  }
  if (/E401|EAUTH|authentication required/i.test(output)) {
    return "A private registry or credential was needed and we don't have one"
  }
  if (/ENOSPC/.test(output)) {
    return "Ran out of disk space in the sandbox"
  }
  if (/JavaScript heap out of memory|ENOMEM/.test(output)) {
    return "Ran out of memory during the build"
  }
  if (/Type error|error TS\d+/.test(output)) {
    return "TypeScript errors in the build"
  }
  return "See the raw log below"
}

async function checkEnvVarsReferenced(sandbox: any, sessionId: string) {
  const referenced = await run(
    sandbox,
    `grep -rhoE "process\\.env\\.[A-Z0-9_]+" --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' /tmp/repo/src /tmp/repo/app /tmp/repo/pages /tmp/repo/lib 2>/dev/null | sed 's/process\\.env\\.//' | sort -u`,
  )
  const vars = referenced.stdout.split("\n").map((v: string) => v.trim()).filter(Boolean)
  if (vars.length === 0) return

  const exampleOut = await run(sandbox, `cat /tmp/repo/.env.example 2>/dev/null || true`)
  const declared = new Set(
    exampleOut.stdout
      .split("\n")
      .map((l: string) => l.match(/^([A-Z0-9_]+)=/)?.[1])
      .filter(Boolean),
  )
  const missing = vars.filter((v: string) => !declared.has(v) && v !== "NODE_ENV")
  if (missing.length > 0) {
    await addLog(
      sessionId,
      "warn",
      `Code references env vars not in .env.example: ${missing.slice(0, 15).join(", ")}${missing.length > 15 ? "…" : ""}`,
      "detect",
    )
  }
}

type OutOfScope = { reason: string } | null

async function checkOutOfScope(sandbox: any, sessionId: string): Promise<OutOfScope> {
  const sizeOut = await run(sandbox, `du -sm /tmp/repo 2>/dev/null | cut -f1`)
  const sizeMb = parseInt(sizeOut.stdout.trim(), 10)
  if (Number.isFinite(sizeMb) && sizeMb > REPO_SIZE_CAP_MB) {
    return { reason: `Repo is ${sizeMb}MB, over the ${REPO_SIZE_CAP_MB}MB cap for this tool` }
  }

  const composeOut = await run(sandbox, `ls /tmp/repo/docker-compose.yml /tmp/repo/docker-compose.yaml /tmp/repo/compose.yml 2>/dev/null || true`)
  if (composeOut.stdout.trim()) {
    return { reason: "This repo needs docker-compose (multiple services) — out of scope for a single sandbox" }
  }

  const procfileOut = await run(sandbox, `cat /tmp/repo/Procfile 2>/dev/null || true`)
  const processTypes = procfileOut.stdout
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => /^[a-zA-Z0-9_-]+:/.test(l))
  if (processTypes.length > 1) {
    return { reason: `Procfile declares ${processTypes.length} process types — this is a multi-process app` }
  }

  const pkgJsonOut = await run(sandbox, `cat /tmp/repo/package.json 2>/dev/null || echo '{}'`)
  let pkg: any = {}
  try {
    pkg = JSON.parse(pkgJsonOut.stdout)
  } catch {
    /* leave pkg empty */
  }
  const deps: Record<string, string> = pkg.dependencies ?? {}
  const dbDeps = ["pg", "mysql", "mysql2", "mongodb", "mongoose", "redis", "ioredis", "cassandra-driver", "amqplib"]
  const foundDbDep = dbDeps.find((d) => deps[d])
  if (foundDbDep) {
    return { reason: `Depends on "${foundDbDep}" — this app needs a database or other service we don't provision` }
  }

  const startScript: string = pkg.scripts?.start ?? ""
  if (/concurrently|docker[- ]compose|foreman/.test(startScript)) {
    return { reason: "The start script launches multiple processes — out of scope for a single sandbox" }
  }

  return null
}

export async function detectRepoSession(session: Session) {
  const sessionId = session.id
  const url = session.inputUrl

  try {
    await updateSession(sessionId, { status: "detecting" })
    await addLog(sessionId, "info", "Requesting a sandbox...", "init")

    const client = getSandboxClient()
    const sandbox = await withCapacityRetry(
      () => client.sandboxes.create({ template: "base", timeoutMs: 5 * 60_000 }),
      (attempt, delayMs) =>
        addLog(sessionId, "warn", `Solari is at capacity, queuing (attempt ${attempt}, retrying in ${Math.round(delayMs / 1000)}s)`, "init"),
    )
    setSandbox(sessionId, sandbox)
    await updateSession(sessionId, { sandboxId: sandbox.sandboxId })
    await addLog(sessionId, "info", `Sandbox ready: ${sandbox.sandboxId}`, "init")
    armWallClockCap(session, sandbox)

    await sandbox.connect()

    await addLog(sessionId, "info", `Cloning ${url}...`, "clone")
    const cloneResult = await run(sandbox, `git clone --depth 1 ${shQuote(url)} /tmp/repo 2>&1`)
    if (cloneResult.exitCode !== 0) {
      const out: string = cloneResult.stdout + cloneResult.stderr
      if (/could not read Username|Authentication failed|repository not found|Permission denied/i.test(out)) {
        await addLog(sessionId, "error", "This looks like a private repository — we don't have credentials for it", "clone")
        await updateSession(sessionId, {
          status: "failed",
          outOfScopeReason: "Private repository — out of scope",
          errorPhase: "out_of_scope",
        })
        await teardown(session)
        return
      }
      await addLog(sessionId, "error", `Clone failed:\n${out}`, "clone")
      await updateSession(sessionId, { status: "failed", errorSummary: "Clone failed", errorPhase: "clone" })
      await teardown(session)
      return
    }
    await addLog(sessionId, "info", "Clone complete", "clone")

    const outOfScope = await checkOutOfScope(sandbox, sessionId)
    if (outOfScope) {
      await addLog(sessionId, "warn", `Out of scope: ${outOfScope.reason}`, "detect")
      await updateSession(sessionId, { status: "failed", outOfScopeReason: outOfScope.reason, errorPhase: "out_of_scope" })
      await teardown(session)
      return
    }

    const lockOut = (await run(sandbox, `ls /tmp/repo/package-lock.json /tmp/repo/pnpm-lock.yaml /tmp/repo/yarn.lock /tmp/repo/bun.lockb 2>/dev/null || true`)).stdout
    let pkgManager = "npm"
    if (lockOut.includes("bun.lockb")) pkgManager = "bun"
    else if (lockOut.includes("pnpm-lock.yaml")) pkgManager = "pnpm"
    else if (lockOut.includes("yarn.lock")) pkgManager = "yarn"
    await addLog(sessionId, "info", `Package manager: ${pkgManager}`, "detect")

    const pkgJsonOut = (await run(sandbox, `cat /tmp/repo/package.json 2>/dev/null || echo '{}'`)).stdout
    let pkg: any = {}
    try {
      pkg = JSON.parse(pkgJsonOut)
    } catch {
      /* leave pkg empty */
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    let framework = "unknown"
    let port = 3000
    if (deps.next) { framework = "Next.js"; port = 3000 }
    else if (deps.vite) { framework = "Vite"; port = 5173 }
    else if (deps["react-scripts"]) { framework = "Create React App"; port = 3000 }
    else if (deps["@remix-run/dev"] || deps["@remix-run/serve"]) { framework = "Remix"; port = 3000 }
    else if (deps.astro) { framework = "Astro"; port = 4321 }
    else if (deps.express || deps.fastify || deps.koa) { framework = "Node server"; port = 3000 }
    await addLog(sessionId, "info", `Framework: ${framework} (default port ${port})`, "detect")

    const hasIndexHtml = (await run(sandbox, `test -f /tmp/repo/index.html && echo yes || echo no`)).stdout.trim() === "yes"
    const hasBuildScript = Boolean(pkg.scripts?.build)
    const isStatic = !hasBuildScript && hasIndexHtml && framework === "unknown"

    if (isStatic) {
      await addLog(sessionId, "info", "Static index.html with no build step detected", "detect")
    } else {
      const nodeVersion = (await run(sandbox, `node --version`)).stdout.trim()
      const engineWant = pkg.engines?.node as string | undefined
      if (engineWant) {
        const wantMajor = engineWant.match(/(\d+)/)?.[1]
        const haveMajor = nodeVersion.match(/v(\d+)/)?.[1]
        if (wantMajor && haveMajor && wantMajor !== haveMajor) {
          await addLog(sessionId, "warn", `package.json wants Node ${engineWant}, sandbox has ${nodeVersion} — install may fail`, "detect")
        }
      }
      await checkEnvVarsReferenced(sandbox, sessionId)
    }

    const installCmd = isStatic
      ? ""
      : pkgManager === "yarn"
        ? "yarn install --frozen-lockfile"
        : pkgManager === "pnpm"
          ? "pnpm install --frozen-lockfile"
          : pkgManager === "bun"
            ? "bun install --frozen-lockfile"
            : "npm ci"
    const buildCmd = isStatic ? "" : hasBuildScript ? `${pkgManager} run build` : ""
    const startCmd = isStatic
      ? `python3 -m http.server ${port} --bind 0.0.0.0`
      : `HOST=0.0.0.0 PORT=${port} ${pkgManager} run start -- --host 0.0.0.0 --port ${port}`

    await updateSession(sessionId, {
      status: "awaiting_confirm",
      detectedFramework: framework,
      detectedPkgManager: pkgManager,
      detectedPort: port,
      installCmd,
      buildCmd,
      startCmd,
      isStatic,
    })
    await addLog(sessionId, "info", "Ready — review the commands and run when you're ready", "detect")
  } catch (err: any) {
    await addLog(sessionId, "error", err?.message ?? "Unknown error during detection", "detect")
    await updateSession(sessionId, { status: "failed", errorSummary: err?.message, errorPhase: "detect" })
    await teardown(session)
  }
}

export async function runRepoSession(
  sessionId: string,
  overrides: { installCmd?: string; buildCmd?: string; startCmd?: string; port?: number },
) {
  const session = await getSession(sessionId)
  if (!session) return
  const sandbox = getSandbox(sessionId)
  if (!sandbox) {
    await addLog(sessionId, "error", "Lost the sandbox for this session — please start over", "start")
    await updateSession(sessionId, { status: "failed", errorSummary: "Sandbox handle was lost" })
    return
  }

  const installCmd = overrides.installCmd ?? session.installCmd ?? ""
  const buildCmd = overrides.buildCmd ?? session.buildCmd ?? ""
  const startCmd = overrides.startCmd ?? session.startCmd ?? ""
  const port = overrides.port ?? session.detectedPort ?? 3000

  try {
    await updateSession(sessionId, { status: "running", installCmd, buildCmd, startCmd, detectedPort: port })

    if (installCmd) {
      await addLog(sessionId, "info", `Installing: ${installCmd}`, "install")
      const installResult = await Promise.race([
        run(sandbox, `cd /tmp/repo && ${installCmd} 2>&1`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("install timed out")), INSTALL_CAP_MS)),
      ])
      const out = installResult.stdout + installResult.stderr
      if (installResult.exitCode !== 0) {
        const summary = summarizeFailure(out)
        await addLog(sessionId, "error", `Install failed — ${summary}\n${out}`, "install")
        await updateSession(sessionId, { status: "failed", errorSummary: summary, errorPhase: "install" })
        await teardown(session)
        return
      }
      await addLog(sessionId, "info", "Install complete", "install")
    }

    if (buildCmd) {
      await addLog(sessionId, "info", `Building: ${buildCmd}`, "build")
      const buildResult = await run(sandbox, `cd /tmp/repo && ${buildCmd} 2>&1`)
      const out = buildResult.stdout + buildResult.stderr
      if (buildResult.exitCode !== 0) {
        const summary = summarizeFailure(out)
        await addLog(sessionId, "error", `Build failed — ${summary}\n${out}`, "build")
        await updateSession(sessionId, { status: "failed", errorSummary: summary, errorPhase: "build" })
        await teardown(session)
        return
      }
      await addLog(sessionId, "info", "Build complete", "build")
    }

    await addLog(sessionId, "info", `Starting: ${startCmd}`, "start")
    await run(sandbox, `cd /tmp/repo && nohup sh -c ${shQuote(startCmd)} > /tmp/server.log 2>&1 &`)

    const { url: previewUrl } = await sandbox.previewUrl(port)
    await updateSession(sessionId, { previewUrl })
    await addLog(sessionId, "info", "Waiting for the server to answer...", "start")

    let ready = false
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const res = await fetch(previewUrl)
        if (res.ok || (res.status >= 300 && res.status < 500)) {
          ready = true
          break
        }
      } catch {
        /* not up yet */
      }
    }

    if (!ready) {
      const serverLog = (await run(sandbox, `tail -30 /tmp/server.log 2>/dev/null`)).stdout
      const summary = summarizeFailure(serverLog)
      await addLog(sessionId, "warn", `Server never answered on port ${port} — ${summary}\n${serverLog}`, "start")
      await updateSession(sessionId, { status: "failed", errorSummary: `Server never came up on port ${port}`, errorPhase: "start" })
      await teardown(session)
      return
    }

    await addLog(sessionId, "info", "Server is live", "start")
    await updateSession(sessionId, { serverReady: true })
  } catch (err: any) {
    await addLog(sessionId, "error", err?.message ?? "Unknown error while running", "start")
    await updateSession(sessionId, { status: "failed", errorSummary: err?.message, errorPhase: "start" })
    await teardown(session)
  }
}

async function teardown(session: Session) {
  const sandbox = getSandbox(session.id)
  if (sandbox) {
    try {
      await sandbox.kill()
    } catch {
      /* already dead */
    }
  }
  forget(session.id)
  await chargeMinutes(session)
}
