import { describe, expect, test } from "vitest"
import { parseModelJson } from "../src/parse.js"

// Models fence their JSON despite being told not to, and reasoning models like
// to narrate first. Neither is a product failure — don't let it look like one.
describe("parseModelJson", () => {
  test("parses bare JSON", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 })
  })

  test("parses JSON inside a ```json fence", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  test("parses JSON preceded by prose", () => {
    expect(parseModelJson('Here is my answer:\n{"a":1}')).toEqual({ a: 1 })
  })

  test("keeps nested braces intact", () => {
    expect(parseModelJson('{"a":{"b":2}}')).toEqual({ a: { b: 2 } })
  })

  test("throws when there is no JSON object at all", () => {
    expect(() => parseModelJson("I could not answer that.")).toThrow(/no json/i)
  })
})
