import assert from "node:assert/strict"
import test from "node:test"

import { parseGitHubIssue, parseGitHubRepository } from "./github.js"

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

test("parses and normalizes a GitHub issue URL", () => {
  assert.deepEqual(parseGitHubIssue("https://github.com/psf/requests/issues/123/"), {
    owner: "psf",
    repository: "requests",
    issueNumber: 123,
    repositoryUrl: "https://github.com/psf/requests",
    issueUrl: "https://github.com/psf/requests/issues/123",
  })
})

test("rejects malformed and ambiguous issue URLs", () => {
  const invalidUrls = [
    "https://example.com/psf/requests/issues/123",
    "http://github.com/psf/requests/issues/123",
    "https://github.com/psf/requests/issues/0",
    "https://github.com/psf/requests/issues/not-a-number",
    "https://github.com/psf/requests/issues/123?notification=1",
    "https://github.com/psf/requests/issues/123#comment",
    "https://github.com/psf/requests/issues/123/comments",
  ]

  for (const url of invalidUrls) {
    assert.throws(() => parseGitHubIssue(url), Error)
  }
})

test("rejects GitHub pull request URLs clearly", () => {
  assert.throws(
    () => parseGitHubIssue("https://github.com/psf/requests/pull/123"),
    /pull request URLs are not supported/,
  )
})
