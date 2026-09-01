export interface GitHubRepository {
  owner: string
  name: string
  slug: string
  url: string
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/

export function parseGitHubRepository(input: string): GitHubRepository {
  const value = input.trim()
  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid GitHub repository URL: ${input}`)
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GitHub repository URL must use http:// or https://")
  }

  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error("GitHub repository URL must use the github.com host")
  }

  if (url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("GitHub repository URL must not include credentials, a port, query, or fragment")
  }

  const pathMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/)
  if (!pathMatch) {
    throw new Error("GitHub repository URL must have the form https://github.com/owner/repository")
  }

  const owner = pathMatch[1]
  const name = pathMatch[2].endsWith(".git") ? pathMatch[2].slice(0, -4) : pathMatch[2]

  if (!OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(name)) {
    throw new Error("GitHub repository URL contains an invalid owner or repository name")
  }

  return {
    owner,
    name,
    slug: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  }
}
