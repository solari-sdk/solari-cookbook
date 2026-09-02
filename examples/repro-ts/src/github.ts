export interface GitHubRepository {
  owner: string
  name: string
  slug: string
  url: string
}

export interface GitHubIssueReference {
  owner: string
  repository: string
  issueNumber: number
  repositoryUrl: string
  issueUrl: string
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/

function parseUrl(input: string, kind: "repository" | "issue"): URL {
  let url: URL

  try {
    url = new URL(input.trim())
  } catch {
    throw new Error(`Invalid GitHub ${kind} URL: ${input}`)
  }

  return url
}

function validateOwnerAndRepository(owner: string, repository: string, kind: "repository" | "issue"): void {
  if (!OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`GitHub ${kind} URL contains an invalid owner or repository name`)
  }
}

function rejectAmbiguousUrlParts(url: URL, kind: "repository" | "issue"): void {
  if (url.port || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `GitHub ${kind} URL must not include credentials, a port, query, or fragment`,
    )
  }
}

export function parseGitHubRepository(input: string): GitHubRepository {
  const url = parseUrl(input, "repository")

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GitHub repository URL must use http:// or https://")
  }

  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error("GitHub repository URL must use the github.com host")
  }

  rejectAmbiguousUrlParts(url, "repository")

  const pathMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/)
  if (!pathMatch) {
    throw new Error("GitHub repository URL must have the form https://github.com/owner/repository")
  }

  const owner = pathMatch[1]
  const name = pathMatch[2].endsWith(".git") ? pathMatch[2].slice(0, -4) : pathMatch[2]

  validateOwnerAndRepository(owner, name, "repository")

  return {
    owner,
    name,
    slug: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  }
}

export function parseGitHubIssue(input: string): GitHubIssueReference {
  const url = parseUrl(input, "issue")

  if (url.protocol !== "https:") {
    throw new Error("GitHub issue URL must use https://")
  }
  if (url.hostname !== "github.com") {
    throw new Error("GitHub issue URL must use the github.com host")
  }

  rejectAmbiguousUrlParts(url, "issue")

  if (/^\/[^/]+\/[^/]+\/pulls?\//.test(url.pathname)) {
    throw new Error("GitHub pull request URLs are not supported in this milestone")
  }

  const pathMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/([^/]+)\/?$/)
  if (!pathMatch) {
    throw new Error("GitHub issue URL must have the form https://github.com/owner/repository/issues/123")
  }

  const owner = pathMatch[1]
  const repository = pathMatch[2]
  const issueNumberText = pathMatch[3]
  validateOwnerAndRepository(owner, repository, "issue")

  if (!/^[1-9]\d*$/.test(issueNumberText)) {
    throw new Error("GitHub issue number must be a positive integer")
  }

  const issueNumber = Number(issueNumberText)
  if (!Number.isSafeInteger(issueNumber)) {
    throw new Error("GitHub issue number is too large")
  }

  const repositoryUrl = `https://github.com/${owner}/${repository}`

  return {
    owner,
    repository,
    issueNumber,
    repositoryUrl,
    issueUrl: `${repositoryUrl}/issues/${issueNumber}`,
  }
}
