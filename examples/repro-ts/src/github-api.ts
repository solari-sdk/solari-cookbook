import type { GitHubIssueReference } from "./github.js"

export interface GitHubIssue {
  title: string
  body: string
  state: string
  labels: string[]
  htmlUrl: string
  repositoryUrl: string
  number: number
}

export interface FetchGitHubIssueOptions {
  token?: string
  fetchImplementation?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== "string") {
    throw new Error(`GitHub issue response is missing a valid ${field} field`)
  }
  return value
}

function mapLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub issue response is missing a valid labels field")
  }

  return value.flatMap((label) => {
    if (typeof label === "string") {
      return [label]
    }
    if (isRecord(label) && typeof label.name === "string") {
      return [label.name]
    }
    return []
  })
}

export function mapGitHubIssuePayload(payload: unknown, repositoryUrl: string): GitHubIssue {
  if (!isRecord(payload)) {
    throw new Error("GitHub returned an invalid issue response")
  }

  if ("pull_request" in payload) {
    throw new Error("The GitHub URL refers to a pull request, which is not supported in this milestone")
  }

  const number = payload.number
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("GitHub issue response is missing a valid number field")
  }

  const body = payload.body
  if (body !== null && typeof body !== "string") {
    throw new Error("GitHub issue response is missing a valid body field")
  }

  return {
    title: requireString(payload, "title"),
    body: body ?? "",
    state: requireString(payload, "state"),
    labels: mapLabels(payload.labels),
    htmlUrl: requireString(payload, "html_url"),
    repositoryUrl,
    number,
  }
}

async function responseMessage(response: Response): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json()
    return isRecord(payload) && typeof payload.message === "string" ? payload.message : undefined
  } catch {
    return undefined
  }
}

export async function fetchGitHubIssue(
  reference: GitHubIssueReference,
  options: FetchGitHubIssueOptions = {},
): Promise<GitHubIssue> {
  const fetchImplementation = options.fetchImplementation ?? fetch
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "solari-repro",
    "X-GitHub-Api-Version": "2022-11-28",
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`
  }

  const apiUrl = `https://api.github.com/repos/${reference.owner}/${reference.repository}/issues/${reference.issueNumber}`
  const response = await fetchImplementation(apiUrl, { headers })

  if (!response.ok) {
    const message = await responseMessage(response)

    if (response.status === 404) {
      throw new Error(`GitHub issue not found: ${reference.owner}/${reference.repository}#${reference.issueNumber}`)
    }

    const rateLimited =
      response.status === 429 ||
      response.headers.get("x-ratelimit-remaining") === "0" ||
      message?.toLowerCase().includes("rate limit")
    if (rateLimited) {
      throw new Error("GitHub API rate limit exceeded. Set GITHUB_TOKEN or try again later.")
    }

    const detail = message ? `: ${message}` : ""
    throw new Error(`GitHub API request failed with ${response.status} ${response.statusText}${detail}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error("GitHub returned an invalid JSON response")
  }

  return mapGitHubIssuePayload(payload, reference.repositoryUrl)
}
