/**
 * Fixer — given a bug report from the watchdog, patches the app's source
 * live inside the same sandbox that's serving it. The app is static files
 * behind `python3 -m http.server`, which reads from disk on every request,
 * so a saved edit is live on the next page load — no build step, no restart.
 */
import type Anthropic from "@anthropic-ai/sdk"
import type { SolariClient } from "@solarisdk/sdk"
import { runToolLoop, type ToolDef } from "./llm.js"
import type { BugReport } from "./types.js"

type Sandbox = Awaited<ReturnType<SolariClient["sandboxes"]["create"]>>

const tools: ToolDef[] = [
  {
    name: "list_dir",
    description: "List file names in a directory inside the sandbox.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the sandbox.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Overwrite a text file in the sandbox with new contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, contents: { type: "string" } },
      required: ["path", "contents"],
    },
  },
  {
    name: "run_command",
    description: "Run a command in the sandbox (e.g. to syntax-check a file). Not shell-interpreted — argv goes in `args`.",
    input_schema: {
      type: "object",
      properties: {
        cmd: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["cmd"],
    },
  },
  {
    name: "report_fix",
    description: "End the run once the fix is written and sanity-checked. Call exactly once.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        filesChanged: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "filesChanged"],
    },
  },
]

export async function runFixer(opts: {
  anthropic: Anthropic
  sandbox: Sandbox
  appDir: string
  bug: BugReport
}): Promise<{ summary: string; filesChanged: string[] }> {
  let result: { summary: string; filesChanged: string[] } | undefined

  const resolve = (p: string) => `${opts.appDir}/${p}`.replace(/\/+/g, "/")

  await runToolLoop({
    anthropic: opts.anthropic,
    system:
      "You are fixing a bug in a small web app's source, live inside a sandbox VM. Read the " +
      "relevant files before editing — never guess at code you haven't read. The app is served " +
      "as static files with no build step and no restart needed. Call `report_fix` exactly once " +
      "you've written and sanity-checked the fix.",
    userMessage:
      `A QA agent tested this app against a spec and it failed.\n\n` +
      `Spec violation: ${opts.bug.summary}\n` +
      `Browser console errors: ${JSON.stringify(opts.bug.consoleErrors)}\n` +
      `App source lives at ${opts.appDir} in this sandbox.\n\n` +
      `Find the bug and fix it.`,
    tools,
    stopTool: "report_fix",
    handleTool: async (name, input) => {
      switch (name) {
        case "list_dir":
          return (await opts.sandbox.files.list(resolve(input.path ?? "")))
            .map((e: { name: string }) => e.name)
            .join("\n")
        case "read_file":
          return await opts.sandbox.files.readText(resolve(input.path))
        case "write_file":
          await opts.sandbox.files.write(resolve(input.path), input.contents)
          return "written"
        case "run_command": {
          const out = await opts.sandbox.commands.run(input.cmd, { args: input.args ?? [] })
          return `exit ${out.exitCode}\n${out.stdout}\n${out.stderr}`
        }
        case "report_fix":
          result = { summary: input.summary, filesChanged: input.filesChanged }
          return "recorded"
        default:
          return `unknown tool ${name}`
      }
    },
  })

  if (!result) throw new Error("fixer stopped without calling report_fix")
  return result
}
