import { describe, expect, test } from "vitest"
import { parseEnv } from "../src/env.js"

describe("parseEnv", () => {
  test("reads simple assignments", () => {
    expect(parseEnv("SOLARI_API_KEY=slr_live_abc")).toEqual({ SOLARI_API_KEY: "slr_live_abc" })
  })

  test("ignores comments and blank lines", () => {
    const parsed = parseEnv(["# a comment", "", "  ", "KEY=value", "# trailing"].join("\n"))

    expect(parsed).toEqual({ KEY: "value" })
  })

  // JWT-ish values and URLs contain '=' and ':'. Splitting on every '=' would
  // silently truncate a key and produce a baffling auth failure.
  test("keeps everything after the first = intact", () => {
    expect(parseEnv("TOKEN=eyJhbGci=abc==")).toEqual({ TOKEN: "eyJhbGci=abc==" })
  })

  test("strips surrounding quotes", () => {
    expect(parseEnv('A="quoted"\nB=\'single\'')).toEqual({ A: "quoted", B: "single" })
  })

  test("trims whitespace around the name and value", () => {
    expect(parseEnv("  KEY  =  value  ")).toEqual({ KEY: "value" })
  })

  test("ignores a line with no assignment", () => {
    expect(parseEnv("not an assignment\nKEY=value")).toEqual({ KEY: "value" })
  })

  test("supports the export prefix", () => {
    expect(parseEnv("export KEY=value")).toEqual({ KEY: "value" })
  })
})
