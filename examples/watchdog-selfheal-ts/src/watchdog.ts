/**
 * Watchdog — an LLM-driven QA agent that drives a Solari cloud browser
 * against a plain-English spec and reports exactly how the page broke.
 *
 * The model gets three interaction tools (click, type, read) plus one
 * terminal tool (`report`) it must call to end the run. Forcing the verdict
 * through a tool call, rather than parsing prose, is what makes the report
 * structured enough for the fixer agent to consume unattended.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { Solari } from "@solarisdk/browser"
import type Anthropic from "@anthropic-ai/sdk"
import { runToolLoop, type ToolDef } from "./llm.js"
import type { WatchdogResult } from "./types.js"

const tools: ToolDef[] = [
  {
    name: "click",
    description: "Click the first element matching a CSS selector.",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
  },
  {
    name: "type",
    description: "Type text into the first element matching a CSS selector (replaces its current value).",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" }, text: { type: "string" } },
      required: ["selector", "text"],
    },
  },
  {
    name: "read",
    description: "Return the innerText of every element matching a CSS selector, as a JSON array.",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
  },
  {
    name: "report",
    description: "End the run. Call this exactly once you can say pass or fail with certainty.",
    input_schema: {
      type: "object",
      properties: {
        passed: { type: "boolean" },
        summary: { type: "string", description: "One sentence: what you did and what happened." },
      },
      required: ["passed", "summary"],
    },
  },
]

export async function runWatchdog(opts: {
  anthropic: Anthropic
  url: string
  spec: string
  outDir: string
}): Promise<WatchdogResult> {
  const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
  // Recording lets you replay exactly what the agent saw, after the fact —
  // see examples/browser-session-recording-py for how to pull it down.
  const browser = await solari.launch({ recording: true })
  const sessionId = browser.id
  const consoleErrors: string[] = []

  try {
    const page = await browser.newPage()
    page.on("pageerror", (err) => consoleErrors.push(String(err)))
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    await page.goto(opts.url)

    let verdict: { passed: boolean; summary: string } | undefined

    await runToolLoop({
      anthropic: opts.anthropic,
      system:
        "You are a QA agent testing a live web page against a spec. Use the tools to interact with " +
        "the page — never assume an action worked, always `read` afterward to confirm. Call `report` " +
        "exactly once you can say pass or fail with certainty.",
      userMessage: `Spec: ${opts.spec}\n\nThe page is already loaded at ${opts.url}. Test it.`,
      tools,
      stopTool: "report",
      handleTool: async (name, input) => {
        switch (name) {
          case "click":
            await page.locator(input.selector).click({ timeout: 5000 })
            return "clicked"
          case "type":
            await page.locator(input.selector).fill(input.text, { timeout: 5000 })
            return "typed"
          case "read": {
            const texts = await page.locator(input.selector).allInnerTexts()
            return JSON.stringify(texts)
          }
          case "report":
            verdict = { passed: input.passed, summary: input.summary }
            return "recorded"
          default:
            return `unknown tool ${name}`
        }
      },
    })

    if (!verdict) {
      verdict = { passed: false, summary: "agent stopped without calling report" }
    }

    if (verdict.passed) {
      return { passed: true, summary: verdict.summary }
    }

    // Capture failure evidence before the session is released — the DOM and
    // screenshot are gone the moment `browser.close()` returns.
    await fs.mkdir(opts.outDir, { recursive: true })
    const screenshotPath = path.join(opts.outDir, "failure.png")
    await page.screenshot({ path: screenshotPath })
    const html = await page.content()

    return {
      passed: false,
      summary: verdict.summary,
      url: opts.url,
      screenshotPath,
      html,
      consoleErrors,
      sessionId,
    }
  } finally {
    await browser.close()
    // Required, or the process never exits — see browser-quickstart-ts.
    await solari.close()
  }
}
