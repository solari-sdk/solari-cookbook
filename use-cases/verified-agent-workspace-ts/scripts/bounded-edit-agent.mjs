import { readFile, writeFile } from "node:fs/promises"

const key = process.env.AGENT_API_KEY
if (!key) throw new Error("Missing AGENT_API_KEY")
const policy = JSON.parse(await readFile("/tmp/verified-agent-policy.json", "utf8"))
const files = {}
for (const path of policy.allowlist) files[path] = await readFile(path, "utf8")
const prompt = [
  policy.taskPrompt,
  policy.feedback ? `PREVIOUS VERIFICATION FAILURE:\n${policy.feedback}` : "",
  "Return strict JSON only: {\"edits\":[{\"path\":\"...\",\"old\":\"exact unique substring\",\"new\":\"replacement\"}]}. Each old substring must occur exactly once. No markdown or explanation.",
  "FILES:",
  ...Object.entries(files).map(([path, content]) => `--- ${path} ---\n${content}`),
].filter(Boolean).join("\n\n")
const res = await fetch(policy.endpoint, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: policy.model,
    temperature: 0,
    max_tokens: policy.maxTokens,
    ...(policy.reasoningMode === "disabled" ? { thinking: { type: "disabled" } } : {}),
    messages: [
      { role: "system", content: policy.systemPrompt },
      { role: "user", content: prompt },
    ],
  }),
})
if (!res.ok) throw new Error(`agent API HTTP ${res.status}`)
const payload = await res.json()
const message = payload?.choices?.[0]?.message
let text = typeof message?.content === "string" ? message.content : ""
text = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
if (!text) throw new Error("agent returned empty content")
let plan
try {
  plan = JSON.parse(text)
} catch {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("agent returned non-JSON content")
  plan = JSON.parse(text.slice(start, end + 1))
}
if (!Array.isArray(plan.edits) || plan.edits.length < 1 || plan.edits.length > 24) throw new Error("invalid edit plan")
const changed = new Set()
const nextFiles = new Map(Object.entries(files))
for (const edit of plan.edits) {
  if (!policy.allowlist.includes(edit.path) || typeof edit.old !== "string" || typeof edit.new !== "string" || !edit.old) throw new Error("invalid edit")
  const current = nextFiles.get(edit.path)
  if (typeof current !== "string") throw new Error(`missing allowlisted file: ${edit.path}`)
  const first = current.indexOf(edit.old)
  if (first < 0 || current.indexOf(edit.old, first + edit.old.length) >= 0) throw new Error(`non-unique old substring: ${edit.path}`)
  nextFiles.set(edit.path, current.slice(0, first) + edit.new + current.slice(first + edit.old.length))
  changed.add(edit.path)
}
for (const path of changed) await writeFile(path, nextFiles.get(path), "utf8")
console.log(JSON.stringify({ model: policy.model, changedFiles: [...changed].sort(), editCount: plan.edits.length }))
