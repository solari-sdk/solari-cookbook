import type { GitHubRepo, PullRequestRef } from "./types.js";

export type { GitHubRepo } from "./types.js";

export function parseGitHubUrl(url: string): GitHubRepo {
  const normalized = url.replace(/\.git$/, "");
  const match = normalized.match(
    /github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/,
  );
  if (!match) {
    throw new Error(`Unsupported GitHub repository URL: ${url}`);
  }
  return { owner: match[1], name: match[2], url: normalized };
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function githubFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error");
    throw new Error(`GitHub API ${res.status} for ${url}: ${text}`);
  }
  return res.json() as Promise<T>;
}

type GitHubPrPayload = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
};

type GitHubFilePayload = {
  filename: string;
};

export async function fetchPullRequest(
  repo: GitHubRepo,
  prNumber: number,
): Promise<PullRequestRef> {
  const pr = await githubFetch<GitHubPrPayload>(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`,
  );

  if (pr.state !== "open") {
    throw new Error(`PR #${prNumber} is not open (state: ${pr.state})`);
  }

  const files = await githubFetch<GitHubFilePayload[]>(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/files?per_page=100`,
  );

  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    baseBranch: pr.base.ref,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    changedFiles: files.map((f) => f.filename),
  };
}

export async function resolveBaseSha(
  repo: GitHubRepo,
  baseBranch: string,
): Promise<string> {
  const data = await githubFetch<{ object: { sha: string } }>(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/git/ref/heads/${baseBranch}`,
  );
  return data.object.sha;
}

export function validatePullRequests(
  prs: PullRequestRef[],
  explicitBaseSha?: string,
): { baseBranch: string; baseSha: string } {
  if (prs.length === 0) {
    throw new Error("No pull requests provided");
  }

  const baseBranch = prs[0].baseBranch;
  const baseBranches = new Set(prs.map((p) => p.baseBranch));
  if (baseBranches.size > 1) {
    throw new Error(
      `PRs target different base branches: ${[...baseBranches].join(", ")}`,
    );
  }

  const baseShas = new Set(prs.map((p) => p.baseSha));
  if (baseShas.size > 1) {
    throw new Error(
      `PRs target different base commits: ${[...baseShas].join(", ")}`,
    );
  }

  const baseSha = explicitBaseSha ?? prs[0].baseSha;
  return { baseBranch, baseSha };
}
