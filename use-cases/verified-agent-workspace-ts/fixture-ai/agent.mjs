import { readFile, writeFile } from "node:fs/promises"

const apiKey = process.env.AGENT_API_KEY
const model = process.env.AGENT_MODEL
const baseUrl = (process.env.AGENT_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "")
const task = process.env.AGENT_TASK ?? "Change the h1 text to exactly: AI repaired this UI in Solari"
if (!apiKey) throw new Error("Missing AGENT_API_KEY")
if (!model) throw new Error("Missing AGENT_MODEL")

const target = new URL("./index.html", import.meta.url)
const original = await readFile(target, "utf8")
const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: "You are a precise coding agent. Return only the complete edited HTML file, with no markdown fences or explanation." },
      { role: "user", content: `${task}\n\nCurrent file:\n${original}` },
    ],
  }),
})
if (!response.ok) throw new Error(`Agent API failed with HTTP ${response.status}`)
const payload = await response.json()
const content = payload?.choices?.[0]?.message?.content
if (typeof content !== "string" || !content.includes("<html") || !content.includes("AI repaired this UI in Solari")) {
  throw new Error("Agent returned invalid HTML")
}
await writeFile(target, `${content.trim()}\n`, "utf8")
console.log(`AI agent edited fixture-ai/index.html with ${model}`)
