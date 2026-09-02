/**
 * The model, with no SDK and no key of its own if you don't want one.
 *
 * Order: ANTHROPIC_API_KEY if you set one, otherwise the `claude` CLI you
 * already have installed. Anyone running Claude Code can use ghostspec without
 * signing up for anything.
 */
import { spawn } from "node:child_process"

const MODEL = process.env.GHOSTSPEC_MODEL ?? "claude-sonnet-5"

export async function ask(prompt: string): Promise<string> {
  return process.env.ANTHROPIC_API_KEY ? viaApi(prompt) : viaCli(prompt)
}

async function viaApi(prompt: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  })
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 400)}`)
  const body = (await r.json()) as { content: { text?: string }[] }
  return body.content.map((c) => c.text ?? "").join("")
}

function viaCli(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Prompt goes down stdin, not argv: a page snapshot blows past ARG_MAX.
    const p = spawn("claude", ["-p", "--output-format", "json", "--model", MODEL], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = "", err = ""
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (err += d))
    p.on("error", () =>
      reject(new Error("no `claude` CLI on PATH and no ANTHROPIC_API_KEY set — need one of them")),
    )
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 400)}`))
      try {
        resolve((JSON.parse(out) as { result: string }).result)
      } catch {
        reject(new Error(`claude returned non-JSON: ${out.slice(0, 400)}`))
      }
    })
    p.stdin.end(prompt)
  })
}

/**
 * Pull the first JSON value out of a reply. Models fence their JSON in
 * ```json blocks about half the time and apologise about it the other half,
 * so scan for the first balanced {...} or [...] rather than trusting the shape.
 */
export function extractJson<T>(reply: string): T {
  const start = reply.search(/[{[]/)
  if (start === -1) throw new Error(`no JSON in model reply: ${reply.slice(0, 200)}`)
  const open = reply[start]
  const close = open === "{" ? "}" : "]"
  let depth = 0, inStr = false, escaped = false
  for (let i = start; i < reply.length; i++) {
    const c = reply[i]
    if (escaped) { escaped = false; continue }
    if (c === "\\") { escaped = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === open) depth++
    else if (c === close && --depth === 0) return JSON.parse(reply.slice(start, i + 1)) as T
  }
  throw new Error(`unbalanced JSON in model reply: ${reply.slice(start, start + 200)}`)
}
