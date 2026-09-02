import assert from "node:assert/strict"
import test from "node:test"

import { mapGitHubIssuePayload } from "./github-api.js"

const repositoryUrl = "https://github.com/psf/requests"

test("maps the useful fields from a GitHub issue payload", () => {
  assert.deepEqual(
    mapGitHubIssuePayload(
      {
        title: "Connection error is unclear",
        body: null,
        state: "open",
        labels: [{ name: "bug" }, { name: "needs-repro" }],
        html_url: "https://github.com/psf/requests/issues/123",
        number: 123,
      },
      repositoryUrl,
    ),
    {
      title: "Connection error is unclear",
      body: "",
      state: "open",
      labels: ["bug", "needs-repro"],
      htmlUrl: "https://github.com/psf/requests/issues/123",
      repositoryUrl,
      number: 123,
    },
  )
})

test("rejects pull requests returned by the GitHub issues endpoint", () => {
  assert.throws(
    () =>
      mapGitHubIssuePayload(
        {
          title: "A pull request",
          body: "",
          state: "open",
          labels: [],
          html_url: "https://github.com/psf/requests/pull/123",
          number: 123,
          pull_request: { url: "https://api.github.com/repos/psf/requests/pulls/123" },
        },
        repositoryUrl,
      ),
    /pull request.*not supported/,
  )
})
