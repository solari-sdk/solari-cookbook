/**
 * Delivery Proof — verify that a delivery does what its spec says, on a
 * sandbox with a clean filesystem and process namespace.
 *
 * The loop: open a sandbox and record what can honestly be claimed about it,
 * run the adopter's own install commands exactly as declared, probe what
 * should now be true (a command, a file, a port, or a whole directory tree
 * matching declared paths and nothing else), and write an offline evidence
 * bundle of what ran, what was observed, what failed.
 *
 * The contract lives in delivery.yaml: `environment`, `deliver`, `expect`.
 * Everything the tool knows about your software arrives through that one
 * file — swap it, and fixtures/installer.sh, for your own.
 *
 * The "installer" here is a synthetic fixture — two inline shell scripts, one
 * of them deliberately broken — so the recipe has no server, no build step,
 * and nothing to install past the Solari SDK and a YAML parser.
 */
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { SandboxClient, type CommandResult } from "@solarisdk/sandbox"
import { parse as parseYaml } from "yaml"

type SandboxHandle = Awaited<ReturnType<SandboxClient["create"]>>

const DEFAULT_SOLARI_BASE_URL = "https://api.getsolari.com"
const DEFAULT_SPEC_PATH = "delivery.yaml"
const RECIPE_VERSION = "0.1.0"
const EVIDENCE_DIR = "evidence"
const GUEST_FIXTURE_DIR = "/tmp/delivery-proof-fixture"
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000
const KILL_TIMEOUT_MS = 20_000
const COMMAND_TIMEOUT_MS = 30_000
const PORT_SETTLE_MS = 500

// What may honestly be claimed about a sandbox's freshness, and no more.
const FRESHNESS_STATEMENT =
  "clean filesystem and process namespace per session; distinct machine id; not a cold boot"

// --- The spec ----------------------------------------------------------

interface DeliverStep {
  id: string
  run: string
}

/** One probe. Fields beyond `id`/`kind` are used per-kind; see checkProbe. */
interface ExpectProbe {
  id: string
  kind: "command" | "file" | "port" | "tree"
  run?: string
  path?: string
  contains?: string
  port?: number
  root?: string
  paths?: string[]
}

interface DeliverySpec {
  environment?: { template?: string; notes?: string }
  deliver: DeliverStep[]
  expect: ExpectProbe[]
}

function parseSpec(path: string): DeliverySpec {
  const parsed = parseYaml(readFileSync(path, "utf8")) as unknown
  if (!parsed || typeof parsed !== "object")
    throw new Error(`${path} is not a YAML mapping`)
  const spec = parsed as Partial<DeliverySpec>
  if (!Array.isArray(spec.deliver) || spec.deliver.length === 0)
    throw new Error(`${path}: "deliver" must be a non-empty list of steps`)
  if (!Array.isArray(spec.expect) || spec.expect.length === 0)
    throw new Error(`${path}: "expect" must be a non-empty list of probes`)
  return spec as DeliverySpec
}

// `${env.NAME}` is the only way a value may vary between runs — resolved
// from the local process env, never written into the spec itself.
const ENV_REF_PATTERN = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g

function resolveRefs(text: string): string {
  return text.replace(
    ENV_REF_PATTERN,
    (_match, name: string) => process.env[name] ?? "",
  )
}

// Any env var whose NAME looks like a credential has its VALUE scrubbed from
// captured guest output before it reaches the evidence bundle — whether the
// spec referenced it or the guest printed it unprompted.
const CREDENTIAL_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD/i

function redact(text: string): string {
  let redacted = text
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 3 || !CREDENTIAL_NAME_PATTERN.test(name))
      continue
    redacted = redacted.split(value).join("[redacted]")
  }
  return redacted
}

async function runShell(
  sandbox: SandboxHandle,
  command: string,
): Promise<CommandResult> {
  return sandbox.commands.run("sh", {
    args: ["-c", command],
    timeoutMs: COMMAND_TIMEOUT_MS,
  })
}

// --- Freshness -----------------------------------------------------------
// Write a new guest identity and read it back in the same round trip that
// reads /proc/uptime and systemd-detect-virt — never trust a baked-in id.
// The kernel's own per-launch identifier is not exposed to a sandbox and is
// not attempted; only the guest's own /etc/machine-id is stamped.

const MACHINE_ID_PATTERN = /^[0-9a-f]{32}$/

interface Freshness {
  statement: string
  sandboxId: string
  machineId: string
  observedUptime: string
  observedVirt: string
}

function blankFreshness(sandboxId: string): Freshness {
  return {
    statement: FRESHNESS_STATEMENT,
    sandboxId,
    machineId: "",
    observedUptime: "",
    observedVirt: "",
  }
}

async function establishFreshness(sandbox: SandboxHandle): Promise<Freshness> {
  const machineId = randomBytes(16).toString("hex")
  const result = await runShell(
    sandbox,
    `printf '%s\\n' '${machineId}' > /etc/machine-id && cat /etc/machine-id && cat /proc/uptime && (systemd-detect-virt || true)`,
  )
  const [readBack, observedUptime, observedVirt] = result.stdout
    .trim()
    .split("\n")
  if (
    result.exitCode !== 0 ||
    readBack !== machineId ||
    !MACHINE_ID_PATTERN.test(readBack ?? "")
  ) {
    throw new Error(
      `could not stamp a new guest machine id (exit ${result.exitCode}): ${readBack || result.stderr}`,
    )
  }
  return {
    statement: FRESHNESS_STATEMENT,
    sandboxId: sandbox.id,
    machineId,
    observedUptime: observedUptime ?? "",
    observedVirt: observedVirt ?? "",
  }
}

// --- Fixture ---------------------------------------------------------------
// The synthetic installer this recipe demonstrates itself against. Swap the
// uploaded file (and delivery.yaml's deliver/expect) for your own.

async function uploadFixture(
  sandbox: SandboxHandle,
  broken: boolean,
): Promise<void> {
  const fixtureFile = broken ? "installer-broken.sh" : "installer.sh"
  const localPath = new URL(`./fixtures/${fixtureFile}`, import.meta.url)
  const contents = readFileSync(localPath, "utf8")
  await sandbox.files.mkdir(GUEST_FIXTURE_DIR)
  await sandbox.files.upload(`${GUEST_FIXTURE_DIR}/installer.sh`, contents)
}

// --- Deliver -----------------------------------------------------------
// Run the adopter's own commands, in order, exactly as declared. Stops at
// the first failing step; later steps are recorded as skipped.

interface StepRecord {
  id: string
  run: string
  exitCode: number
  durationMs: number
  stdout: string
  stderr: string
  skipped: boolean
}

async function runDeliverSteps(
  sandbox: SandboxHandle,
  steps: DeliverStep[],
): Promise<StepRecord[]> {
  const records: StepRecord[] = []
  let stopped = false
  for (const step of steps) {
    if (stopped) {
      records.push({
        id: step.id,
        run: step.run,
        exitCode: -1,
        durationMs: 0,
        stdout: "",
        stderr: "",
        skipped: true,
      })
      continue
    }
    const t0 = Date.now()
    const result = await runShell(sandbox, resolveRefs(step.run))
    records.push({
      id: step.id,
      run: step.run,
      exitCode: result.exitCode,
      durationMs: Date.now() - t0,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
      skipped: false,
    })
    if (result.exitCode !== 0) stopped = true
  }
  return records
}

// --- Expect --------------------------------------------------------------
// Four probe kinds. `tree` reads "delivers exactly": every declared path
// must be present, and nothing this run created may be absent from that
// list — checked against a snapshot taken before `deliver` runs, so
// pre-existing, untouched paths are never mistaken for a leak.

interface ProbeRecord {
  id: string
  kind: ExpectProbe["kind"]
  expected: string
  observed: string
  ok: boolean
}

async function listTreeFiles(
  sandbox: SandboxHandle,
  root: string,
): Promise<string[]> {
  const result = await runShell(
    sandbox,
    `[ -d "${root}" ] && find "${root}" -type f || true`,
  )
  const prefix = `${root}/`
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
}

async function snapshotTreeRoots(
  sandbox: SandboxHandle,
  probes: ExpectProbe[],
): Promise<Map<string, string[]>> {
  const snapshots = new Map<string, string[]>()
  for (const probe of probes) {
    if (probe.kind === "tree")
      snapshots.set(probe.id, await listTreeFiles(sandbox, probe.root ?? ""))
  }
  return snapshots
}

function probeRecord(
  probe: ExpectProbe,
  expected: string,
  observed: string,
  ok: boolean,
): ProbeRecord {
  return { id: probe.id, kind: probe.kind, expected, observed, ok }
}

async function checkProbe(
  sandbox: SandboxHandle,
  probe: ExpectProbe,
  preSnapshot: string[],
): Promise<ProbeRecord> {
  if (probe.kind === "command") {
    const result = await runShell(sandbox, resolveRefs(probe.run ?? ""))
    const detail = result.stderr
      ? `: ${redact(result.stderr.trim()).slice(0, 200)}`
      : ""
    return probeRecord(
      probe,
      "exits zero",
      `exit ${result.exitCode}${detail}`,
      result.exitCode === 0,
    )
  }
  if (probe.kind === "file") {
    let content = ""
    let exists = true
    try {
      content = await sandbox.files.readText(probe.path ?? "")
    } catch {
      exists = false
    }
    const matches =
      !probe.contains || (exists && new RegExp(probe.contains).test(content))
    const expected = probe.contains
      ? `exists, matching /${probe.contains}/`
      : "exists"
    const observed = exists
      ? matches
        ? "present, matches"
        : "present, no match"
      : "missing"
    return probeRecord(probe, expected, observed, exists && matches)
  }
  if (probe.kind === "port") {
    const result = await runShell(
      sandbox,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${probe.port}/`,
    )
    const status = result.stdout.trim()
    const ok = result.exitCode === 0 && status !== ""
    const observed = ok
      ? `http ${status}`
      : `no response (curl exit ${result.exitCode})`
    return probeRecord(
      probe,
      `answers on localhost:${probe.port}`,
      observed,
      ok,
    )
  }
  const root = probe.root ?? ""
  const paths = probe.paths ?? []
  const post = await listTreeFiles(sandbox, root)
  const postSet = new Set(post)
  const preSet = new Set(preSnapshot)
  const declared = new Set(paths)
  const missing = paths.filter((path) => !postSet.has(path))
  const undeclared = post.filter(
    (path) => !declared.has(path) && !preSet.has(path),
  )
  const parts = [
    missing.length ? `missing: ${missing.join(", ")}` : "",
    undeclared.length ? `undeclared: ${undeclared.join(", ")}` : "",
  ].filter(Boolean)
  const observed = parts.length
    ? parts.join("; ")
    : `exactly [${post.join(", ")}]`
  return probeRecord(
    probe,
    `exactly [${paths.join(", ")}] under ${root}`,
    observed,
    missing.length === 0 && undeclared.length === 0,
  )
}

async function runProbes(
  sandbox: SandboxHandle,
  probes: ExpectProbe[],
  preTreeSnapshots: Map<string, string[]>,
): Promise<ProbeRecord[]> {
  const records: ProbeRecord[] = []
  for (const probe of probes)
    records.push(
      await checkProbe(sandbox, probe, preTreeSnapshots.get(probe.id) ?? []),
    )
  return records
}

// --- Evidence ------------------------------------------------------------

interface RunRecord {
  runId: string
  timestamp: string
  recipeVersion: string
  specPath: string
  broken: boolean
  freshness: Freshness
  outcome: "verified" | "failed" | "error"
  exitCode: 0 | 1 | 2
  steps: StepRecord[]
  probes: ProbeRecord[]
  error?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  )

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n")
}

function transcriptText(record: RunRecord): string {
  const lines: string[] = []
  lines.push(`run ${record.runId} — ${record.timestamp}`)
  lines.push(`freshness: ${record.freshness.statement}`)
  lines.push(
    `sandbox: ${record.freshness.sandboxId}  machine: ${record.freshness.machineId}`,
  )
  lines.push(
    `uptime: ${record.freshness.observedUptime}  virt: ${record.freshness.observedVirt}`,
  )
  lines.push("", "deliver:")
  for (const step of record.steps) {
    lines.push(
      step.skipped
        ? `  [skip] ${step.id}: ${step.run}`
        : `  [${step.exitCode === 0 ? "ok" : "FAIL"}] ${step.id} (${step.durationMs}ms): ${step.run}`,
    )
    if (step.stdout) lines.push(indent(step.stdout))
    if (step.stderr) lines.push(indent(step.stderr))
  }
  lines.push("", "expect:")
  for (const probe of record.probes)
    lines.push(
      `  [${probe.ok ? "ok" : "FAIL"}] ${probe.id} (${probe.kind}) — expected: ${probe.expected} — observed: ${probe.observed}`,
    )
  lines.push("", `outcome: ${record.outcome} (exit ${record.exitCode})`)
  if (record.error) lines.push(`error: ${record.error}`)
  return `${lines.join("\n")}\n`
}

function renderHtml(record: RunRecord): string {
  const stepRows = record.steps
    .map((step) => {
      const status = step.skipped
        ? "skipped"
        : step.exitCode === 0
          ? "passed"
          : "failed"
      return `<tr class="${status}"><td>${escapeHtml(step.id)}</td><td><code>${escapeHtml(step.run)}</code></td><td>${step.skipped ? "-" : step.exitCode}</td><td>${step.skipped ? "-" : `${step.durationMs}ms`}</td><td>${status}</td></tr>`
    })
    .join("\n")
  const probeRows = record.probes
    .map((probe) => {
      const status = probe.ok ? "passed" : "failed"
      return `<tr class="${status}"><td>${escapeHtml(probe.id)}</td><td>${probe.kind}</td><td>${escapeHtml(probe.expected)}</td><td>${escapeHtml(probe.observed)}</td><td>${status}</td></tr>`
    })
    .join("\n")
  return `<!doctype html>
<meta charset="utf-8"><title>Delivery Proof run</title>
<style>
 body{font:15px system-ui;max-width:56rem;margin:3rem auto;color:#111}
 table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
 tr.failed{background:#fdecea} tr.passed{background:#e9f7ef} tr.skipped{background:#f6f6f6}
 code{white-space:pre-wrap}
</style>
<h1>Delivery Proof run</h1>
<p>run <code>${escapeHtml(record.runId)}</code> · ${escapeHtml(record.timestamp)} · outcome: <b>${record.outcome}</b> (exit ${record.exitCode})</p>
<h2>Freshness</h2>
<p>${escapeHtml(record.freshness.statement)}</p>
<p>sandbox <code>${escapeHtml(record.freshness.sandboxId)}</code> · machine <code>${escapeHtml(record.freshness.machineId)}</code></p>
<p>observed uptime: <code>${escapeHtml(record.freshness.observedUptime)}</code> · observed virt: <code>${escapeHtml(record.freshness.observedVirt)}</code></p>
<h2>Deliver</h2>
<table><tr><th>#</th><th>run</th><th>exit</th><th>duration</th><th>status</th></tr>
${stepRows}
</table>
<h2>Expect</h2>
<table><tr><th>#</th><th>kind</th><th>expected</th><th>observed</th><th>status</th></tr>
${probeRows}
</table>
${record.error ? `<h2>Error</h2><pre>${escapeHtml(record.error)}</pre>` : ""}`
}

async function writeEvidenceBundle(record: RunRecord): Promise<string> {
  const dir = `${EVIDENCE_DIR}/${record.runId}`
  await mkdir(dir, { recursive: true })
  await writeFile(`${dir}/record.json`, `${JSON.stringify(record, null, 2)}\n`)
  await writeFile(`${dir}/transcript.txt`, transcriptText(record))
  await writeFile(`${dir}/index.html`, renderHtml(record))
  return dir
}

// --- The run -------------------------------------------------------------

async function closeSandbox(sandbox: SandboxHandle): Promise<boolean> {
  let timer!: NodeJS.Timeout
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), KILL_TIMEOUT_MS)
  })
  const killed = sandbox
    .kill()
    .then(() => true)
    .catch(() => false)
  try {
    return await Promise.race([killed, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

async function runDelivery(
  sandbox: SandboxHandle,
  spec: DeliverySpec,
  meta: { runId: string; specPath: string; broken: boolean },
): Promise<RunRecord> {
  const base = {
    runId: meta.runId,
    recipeVersion: RECIPE_VERSION,
    specPath: meta.specPath,
    broken: meta.broken,
  }
  try {
    await sandbox.connect()
    console.log(`sandbox ${sandbox.id} connected`)

    const freshness = await establishFreshness(sandbox)
    console.log(`freshness: ${freshness.statement}`)
    console.log(
      `  sandbox ${freshness.sandboxId} machine ${freshness.machineId}`,
    )
    console.log(
      `  observed uptime ${freshness.observedUptime} virt ${freshness.observedVirt}`,
    )

    const preTreeSnapshots = await snapshotTreeRoots(sandbox, spec.expect)
    await uploadFixture(sandbox, meta.broken)

    console.log("delivering:")
    const steps = await runDeliverSteps(sandbox, spec.deliver)
    for (const step of steps)
      console.log(
        `  ${step.skipped ? "skip" : step.exitCode === 0 ? "ok  " : "FAIL"} ${step.id}`,
      )

    // A backgrounded server needs a moment past the launching step's own
    // exit before it reliably answers — a fixed grace window, not a poll loop.
    await new Promise((resolve) => setTimeout(resolve, PORT_SETTLE_MS))

    console.log("checking:")
    const probes = await runProbes(sandbox, spec.expect, preTreeSnapshots)
    for (const probe of probes)
      console.log(
        `  ${probe.ok ? "ok  " : "FAIL"} ${probe.id} — ${probe.observed}`,
      )

    const failed =
      steps.some((step) => !step.skipped && step.exitCode !== 0) ||
      probes.some((probe) => !probe.ok)
    return {
      ...base,
      timestamp: new Date().toISOString(),
      freshness,
      outcome: failed ? "failed" : "verified",
      exitCode: failed ? 1 : 0,
      steps,
      probes,
    }
  } catch (error) {
    console.error("delivery run failed:", errorMessage(error))
    return {
      ...base,
      timestamp: new Date().toISOString(),
      freshness: blankFreshness(sandbox.id),
      outcome: "error",
      exitCode: 2,
      steps: [],
      probes: [],
      error: errorMessage(error),
    }
  }
}

function specPathFromArgs(): string {
  const flagIndex = process.argv.indexOf("--spec")
  const value = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined
  return value ?? DEFAULT_SPEC_PATH
}

function fail(message: string): 2 {
  console.error(message)
  return 2
}

async function main(): Promise<number> {
  const runId = `${Date.now()}-${randomBytes(3).toString("hex")}`
  const specPath = specPathFromArgs()
  const broken = process.env.DELIVERY_PROOF_BROKEN === "1"

  let spec: DeliverySpec
  try {
    spec = parseSpec(specPath)
  } catch (error) {
    return fail(errorMessage(error))
  }

  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) return fail("SOLARI_API_KEY is not set — see .env.example")

  const client = new SandboxClient({
    apiKey,
    baseUrl: process.env.SOLARI_BASE_URL ?? DEFAULT_SOLARI_BASE_URL,
  })
  const template = spec.environment?.template ?? "base"
  console.log(
    `provisioning a sandbox (template: ${template})${broken ? " — DELIVERY_PROOF_BROKEN=1" : ""}`,
  )

  let sandbox: SandboxHandle
  try {
    sandbox = await client.create({
      template,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      metadata: { recipe: "delivery-proof-ts" },
    })
  } catch (error) {
    return fail(`could not provision a sandbox: ${errorMessage(error)}`)
  }

  let exitCode = 2
  try {
    let record = await runDelivery(sandbox, spec, { runId, specPath, broken })
    try {
      const dir = await writeEvidenceBundle(record)
      console.log(`\nevidence: ${dir}/index.html`)
    } catch (error) {
      console.error("could not write the evidence bundle:", errorMessage(error))
      record = { ...record, outcome: "error", exitCode: 2 }
    }
    console.log(`outcome: ${record.outcome} (exit ${record.exitCode})`)
    exitCode = record.exitCode
  } finally {
    const cleanupOk = await closeSandbox(sandbox)
    console.log(
      cleanupOk
        ? `sandbox ${sandbox.id} killed`
        : `sandbox ${sandbox.id} did not confirm teardown within ${KILL_TIMEOUT_MS}ms`,
    )
    if (!cleanupOk) exitCode = 2
  }
  return exitCode
}

process.exitCode = await main()
