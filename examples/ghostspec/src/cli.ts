#!/usr/bin/env node
/**
 * ghostspec — describe a flow in English, get a Playwright spec that is
 * verified to pass before you're handed it.
 *
 * explore (real browser) ─► generate (from the observed trace) ─► verify (fresh browser)
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { explore } from "./explore.js"
import { generateSpec } from "./generate.js"
import { writeReport } from "./report.js"
import { emitRunnerFiles, verifySpec } from "./verify.js"
import type { RunResult } from "./types.js"

const HELP = `ghostspec — AI-written Playwright tests, verified on a cloud browser.

  npx ghostspec <url> "<flow in plain English>" [options]

  --out <dir>       where to write everything      (default ./ghostspec-out)
  --name <slug>     spec filename                  (default: from the flow)
  --max-steps <n>   ceiling on exploration steps   (default 25)
  --no-verify       write the spec without proving it passes
  -h, --help

Needs SOLARI_API_KEY (console.getsolari.com) in the environment or a .env.
Uses your \`claude\` CLI for the model, or ANTHROPIC_API_KEY if you set one.

  npx ghostspec https://www.saucedemo.com \\
    "log in as standard_user / secret_sauce, add a backpack to the cart, check out"
`

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const opts: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "-h" || a === "--help") opts.help = true
    else if (a === "--no-verify") opts.verify = false
    else if (a.startsWith("--")) opts[a.slice(2)] = argv[++i] ?? ""
    else positional.push(a)
  }
  return { positional, opts }
}

/** "log in and check out" -> "log-in-and-check-out", capped so it stays a sane filename. */
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "flow"

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2))
  const [url, goal] = positional
  if (opts.help || !url || !goal) {
    console.log(HELP)
    process.exit(opts.help ? 0 : 2)
  }

  const outDir = resolve(String(opts.out ?? "ghostspec-out"))
  const name = slug(String(opts.name ?? goal))
  const maxSteps = Number(opts["max-steps"] ?? 25)
  mkdirSync(outDir, { recursive: true })

  console.log(`\n  ${url}\n  "${goal}"\n`)

  console.log("  exploring on a Solari cloud browser…")
  const trace = await explore(url, goal, { maxSteps, outDir })
  console.log(`  ${trace.steps.length} steps observed${trace.failed ? ` (stopped: ${trace.failed})` : ""}`)

  // The replay URL Solari hands back is a presigned S3 link that dies in ~15 minutes.
  // Pull the file down now so the report is still worth something tomorrow; if the
  // fetch fails we keep the URL, which is no worse than not trying.
  if (trace.replayUrl?.startsWith("http")) {
    const local = `${name}.replay.ndjson.gz`
    try {
      const r = await fetch(trace.replayUrl)
      if (r.ok) {
        writeFileSync(join(outDir, local), Buffer.from(await r.arrayBuffer()))
        trace.replayUrl = local
      }
    } catch {
      /* keep the presigned URL */
    }
  }

  console.log("  writing the spec…")
  const spec = await generateSpec(trace)

  let run: RunResult | null = null
  if (opts.verify !== false) {
    console.log("  verifying it on a fresh browser…")
    run = await verifySpec(spec, join(outDir, ".verify"))
    console.log(`  ${run.passed} passed, ${run.failed} failed`)
  }

  // The spec is written whatever happens — a failing spec plus its output is
  // still the most useful thing we can hand back. The exit code carries the
  // verdict, so CI can branch on it.
  const specPath = join(outDir, `${name}.spec.ts`)
  writeFileSync(specPath, spec)
  emitRunnerFiles(outDir)
  const reportPath = join(outDir, `${name}.html`)
  writeReport(reportPath, trace, run)

  console.log(`\n  spec    ${specPath}`)
  console.log(`  report  ${reportPath}`)
  if (trace.replayUrl) console.log(`  replay  ${trace.replayUrl}`)
  // A spec can pass and still not be the thing that was asked for: if exploration
  // gave up early, the generated test faithfully covers a flow that stopped at
  // step 4 of 12. Reporting that as "verified" would be the one lie this tool
  // exists to avoid, so an unfinished flow is a failure regardless of the run.
  const incomplete = Boolean(trace.failed)
  console.log(
    incomplete
      ? `\n  INCOMPLETE — exploration stopped before finishing the flow: ${trace.failed}\n` +
          "  The spec covers only what it reached. Re-run, or narrow the flow.\n"
      : run && run.failed === 0
        ? "\n  verified — this spec passed on a real browser.\n"
        : run
          ? "\n  NOT verified — see the report for the failure.\n"
          : "\n  unverified (--no-verify).\n",
  )
  process.exit(incomplete || (run && run.failed > 0) ? 1 : 0)
}

main().catch((e) => {
  console.error(`\nghostspec: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
