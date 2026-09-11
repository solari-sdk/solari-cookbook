/**
 * Extract a JSON object from a model response.
 *
 * Models fence their JSON despite instructions, and reasoning models narrate
 * before committing. Neither is a product failure, so neither should surface as
 * one. Slices from the first `{` to the last `}` so nested objects survive.
 */
export function parseModelJson(raw: string): unknown {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object in model response: ${raw.slice(0, 200)}`)
  }
  return JSON.parse(raw.slice(start, end + 1))
}
