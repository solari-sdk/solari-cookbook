/**
 * Delivery proof — "it runs" is not "it delivered exactly what it declared".
 *
 * delivery.yaml is the contract: the commands you would type to install your
 * software, and what must be true afterwards — a command that exits zero, a
 * file with the right content, a port that answers, and a directory tree that
 * holds exactly the declared paths and nothing else. This runs that contract
 * twice, each time on a new sandbox: once against an installer that honours
 * it, once against a build that drifted. The drifted build still comes up, so
 * every "does it work" check passes; only the file and tree checks see what
 * it really shipped.
 *
 * The installer is an inline shell script standing in for your own. Swap it
 * and delivery.yaml for your real install commands and contract.
 */
import { readFileSync } from "node:fs"
import { SandboxClient } from "@solarisdk/sandbox"
import { parse as parseYaml } from "yaml"

type Sandbox = Awaited<ReturnType<SandboxClient["create"]>>

const INSTALLER_PATH = "/tmp/installer.sh"
const COMMAND_TIMEOUT_MS = 30_000
const PORT_SETTLE_MS = 500

// ---------------------------------------------------------------------------
// The installer under test: one that honours the contract, one that drifted.
// ---------------------------------------------------------------------------

const INSTALLER = `#!/bin/sh
set -eu
mkdir -p /opt/widgetd/bin /etc/widgetd /var/lib/widgetd
cat > /opt/widgetd/bin/widgetd <<'BIN'
#!/bin/sh
case "\${1:-}" in
  --version) echo "widgetd 1.0.0" ;;
  start)
    PORT=$(grep '^port=' /etc/widgetd/widgetd.conf 2>/dev/null | cut -d= -f2)
    nohup python3 -m http.server "\${PORT:-8080}" --directory /var/lib/widgetd >/var/log/widgetd.log 2>&1 &
    echo "started on port \${PORT:-8080}" ;;
  *) echo "usage: widgetd [--version|start]" >&2; exit 1 ;;
esac
BIN
chmod +x /opt/widgetd/bin/widgetd
printf 'port=8080\\n' > /etc/widgetd/widgetd.conf
echo "<p>widgetd is running</p>" > /var/lib/widgetd/index.html
echo "installed widgetd"
`

// The build that drifted, as the two mistakes it really was: the config lands
// under the wrong name, and a debug copy of the binary ships alongside the real
// one. widgetd falls back to its default port, so the service still comes up.
const DRIFTED_INSTALLER = INSTALLER.replace(
  "> /etc/widgetd/widgetd.conf\n",
  "> /etc/widgetd/widgetd.conf.bak\n",
).replace(
  "chmod +x /opt/widgetd/bin/widgetd\n",
  "chmod +x /opt/widgetd/bin/widgetd\ncp /opt/widgetd/bin/widgetd /opt/widgetd/bin/widgetd.debug\n",
)

// ---------------------------------------------------------------------------
// The contract, read from delivery.yaml.
// ---------------------------------------------------------------------------

interface DeliverStep {
  id: string
  run: string
}

/** One probe. Fields beyond `id`/`kind` are used per kind; see checkProbe. */
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
  environment?: { template?: string }
  deliver: DeliverStep[]
  expect: ExpectProbe[]
}

function parseSpec(path: string): DeliverySpec {
  const spec = parseYaml(readFileSync(path, "utf8")) as Partial<DeliverySpec>
  if (!Array.isArray(spec?.deliver) || spec.deliver.length === 0)
    throw new Error(`${path}: "deliver" must be a non-empty list of steps`)
  if (!Array.isArray(spec.expect) || spec.expect.length === 0)
    throw new Error(`${path}: "expect" must be a non-empty list of probes`)
  return spec as DeliverySpec
}

// ---------------------------------------------------------------------------
// Deliver, then check.
// ---------------------------------------------------------------------------

// Sandbox commands are not shell-interpreted: run("ls -la") looks for a binary
// named "ls -la". Hand the line to sh.
const runShell = (sandbox: Sandbox, command: string) =>
  sandbox.commands.run("sh", {
    args: ["-c", command],
    timeoutMs: COMMAND_TIMEOUT_MS,
  })

async function listTree(sandbox: Sandbox, root: string): Promise<string[]> {
  const result = await runShell(
    sandbox,
    `[ -d "${root}" ] && find "${root}" -type f || true`,
  )
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(`${root}/`, ""))
}

interface Reading {
  id: string
  ok: boolean
  observed: string
}

/**
 * `tree` reads "delivers exactly": every declared path must be present, and
 * nothing this run created may be missing from the list. It is checked against
 * a snapshot taken BEFORE the installer ran, so a path that was already there
 * is never mistaken for something you shipped.
 */
async function checkProbe(
  sandbox: Sandbox,
  probe: ExpectProbe,
  before: string[],
): Promise<Reading> {
  if (probe.kind === "command") {
    const result = await runShell(sandbox, probe.run ?? "")
    return {
      id: probe.id,
      ok: result.exitCode === 0,
      observed: `exit ${result.exitCode}`,
    }
  }
  if (probe.kind === "file") {
    let content: string | null = null
    try {
      content = await sandbox.files.readText(probe.path ?? "")
    } catch {
      content = null
    }
    if (content === null)
      return { id: probe.id, ok: false, observed: "missing" }
    const ok = !probe.contains || new RegExp(probe.contains).test(content)
    return {
      id: probe.id,
      ok,
      observed: ok ? "present, matches" : "present, no match",
    }
  }
  if (probe.kind === "port") {
    const result = await runShell(
      sandbox,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${probe.port}/`,
    )
    const status = result.stdout.trim()
    const ok = result.exitCode === 0 && status !== ""
    return { id: probe.id, ok, observed: ok ? `http ${status}` : "no response" }
  }
  const after = await listTree(sandbox, probe.root ?? "")
  const declared = new Set(probe.paths ?? [])
  const missing = (probe.paths ?? []).filter((path) => !after.includes(path))
  const undeclared = after.filter(
    (path) => !declared.has(path) && !before.includes(path),
  )
  const notes = [
    missing.length ? `missing: ${missing.join(", ")}` : "",
    undeclared.length ? `undeclared: ${undeclared.join(", ")}` : "",
  ].filter(Boolean)
  return {
    id: probe.id,
    ok: notes.length === 0,
    observed: notes.length ? notes.join("; ") : `exactly [${after.join(", ")}]`,
  }
}

/** Upload the installer, run the contract's steps in order, then its probes. */
async function deliverAndCheck(
  sandbox: Sandbox,
  spec: DeliverySpec,
  installer: string,
): Promise<{ delivered: boolean; readings: Reading[] }> {
  await sandbox.files.upload(INSTALLER_PATH, installer)
  const before = new Map<string, string[]>()
  for (const probe of spec.expect)
    if (probe.kind === "tree")
      before.set(probe.id, await listTree(sandbox, probe.root ?? ""))

  for (const step of spec.deliver) {
    const result = await runShell(sandbox, step.run)
    console.log(
      `  ${step.id} — ${result.exitCode === 0 ? "ok" : `FAILED: exit ${result.exitCode}`}`,
    )
    if (result.exitCode !== 0) return { delivered: false, readings: [] }
  }
  // A backgrounded server needs a moment past its launching step's exit.
  await new Promise((resolve) => setTimeout(resolve, PORT_SETTLE_MS))

  const readings: Reading[] = []
  for (const probe of spec.expect) {
    const reading = await checkProbe(sandbox, probe, before.get(probe.id) ?? [])
    console.log(
      `  ${probe.id} (${probe.kind}) — ${reading.ok ? "ok" : "FAILED"}: ${reading.observed}`,
    )
    readings.push(reading)
  }
  return { delivered: true, readings }
}

/**
 * Does this installer pass the contract? One NEW sandbox per attempt — the
 * contract describes what an untouched one looks like after install.
 */
async function passesContract(
  client: SandboxClient,
  spec: DeliverySpec,
  label: string,
  installer: string,
): Promise<boolean> {
  const template = spec.environment?.template ?? "base"
  // Rolling IDLE window — it resets on every use, it is not a hard deadline.
  const sandbox = await client.create({ template, timeoutMs: 10 * 60_000 })
  console.log(`${label}  (sandbox ${sandbox.id})`)
  try {
    await sandbox.connect()
    const { delivered, readings } = await deliverAndCheck(
      sandbox,
      spec,
      installer,
    )
    return delivered && readings.every((reading) => reading.ok)
  } finally {
    // kill() destroys the VM. close() alone would leave it running until the idle timeout.
    await sandbox.kill()
  }
}

async function main(): Promise<number> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is not set — see .env.example")
  const spec = parseSpec("delivery.yaml")
  const client = new SandboxClient({
    apiKey,
    baseUrl: process.env.SOLARI_BASE_URL ?? "https://api.getsolari.com",
  })

  const label1 = "run 1 — the installer that honours the contract"
  if (!(await passesContract(client, spec, label1, INSTALLER))) {
    console.log(
      "\nthe honouring installer failed the contract — the fixture is stale",
    )
    return 1
  }
  const label2 = "\nrun 2 — the build that drifted"
  if (await passesContract(client, spec, label2, DRIFTED_INSTALLER)) {
    console.log(
      "\nthe drifted build passed the contract — the fixture is stale",
    )
    return 1
  }
  console.log(
    "\ndrift caught: the service came up, and the contract still failed on what was shipped",
  )
  return 0
}

process.exitCode = await main()
