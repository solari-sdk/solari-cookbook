import assert from "node:assert/strict"
import test from "node:test"
import { PERSONAS, FIVE_PERSONAS, ALL_PERSONAS, findPersona } from "./personas.js"

test("Milestone 2 defines exactly three distinct behavioral personas", () => {
  assert.equal(PERSONAS.length, 3)
  assert.deepEqual(
    PERSONAS.map((persona) => persona.name),
    ["Normal User", "Confused User", "Speedrunner"],
  )
  assert.equal(new Set(PERSONAS.map((persona) => persona.id)).size, 3)
  assert.equal(new Set(PERSONAS.map((persona) => persona.instructions)).size, 3)
  for (const persona of PERSONAS) {
    assert.ok(persona.instructions.length > 80)
  }
})

test("Milestone 5 extends the original three with two distinct safe personas", () => {
  assert.equal(FIVE_PERSONAS.length, 5)
  assert.deepEqual(FIVE_PERSONAS.slice(0, 3), PERSONAS)
  assert.equal(new Set(FIVE_PERSONAS.map((persona) => persona.id)).size, 5)
  assert.equal(new Set(FIVE_PERSONAS.map((persona) => persona.instructions)).size, 5)
  assert.equal(findPersona("back-button").name, "Back Button Goblin")
  assert.equal(findPersona("explorer").name, "Explorer")
  assert.throws(() => findPersona("unknown"), /Unknown/)
})

test("Milestone 6 provides twenty distinct resolvable profiles without changing earlier presets", () => {
  assert.equal(ALL_PERSONAS.length, 20)
  assert.deepEqual(ALL_PERSONAS.slice(0, 5), FIVE_PERSONAS)
  for (const key of ["id", "name", "instructions"] as const) {
    assert.equal(new Set(ALL_PERSONAS.map((persona) => persona[key])).size, 20)
  }
  for (const persona of ALL_PERSONAS) {
    assert.equal(findPersona(persona.id), persona)
    assert.ok(persona.instructions.length > 80)
  }
})
