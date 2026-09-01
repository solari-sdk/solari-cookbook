import assert from "node:assert/strict"
import test from "node:test"

import { parseGitHubRepository } from "./github.js"

test("normalizes a public GitHub repository URL", () => {
  assert.deepEqual(parseGitHubRepository(" http://www.github.com/psf/requests.git/ "), {
    owner: "psf",
    name: "requests",
    slug: "psf/requests",
    url: "https://github.com/psf/requests",
  })
})

test("rejects non-GitHub and non-repository URLs", () => {
  assert.throws(() => parseGitHubRepository("https://example.com/psf/requests"), /github\.com host/)
  assert.throws(() => parseGitHubRepository("https://github.com/psf/requests/issues/1"), /form/)
  assert.throws(() => parseGitHubRepository("git@github.com:psf/requests.git"), /Invalid GitHub/)
})
