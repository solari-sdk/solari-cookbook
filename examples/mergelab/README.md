# MergeLab

**Test pull requests together before they break together.**

MergeLab is an AI-assisted integration-risk simulator for GitHub pull requests.
It accepts a public repository and 2–3 open PRs, constructs every individual and
pairwise future state inside an isolated Solari sandbox, runs the repository's
own checks and a Playwright journey against each state, and produces a
compatibility matrix with deterministic evidence.

> PR A passes. PR B passes. A + B merge cleanly but fail together. MergeLab
> proves why before either PR is merged.

## Problem

CI normally tests each PR against the current base branch. Two PRs can both pass
independently but become incompatible when combined:

- A backend PR changes an API response while a frontend PR expects the old shape.
- One PR upgrades a dependency while another imports a removed API.
- Code merges without textual conflicts but fails semantically at runtime.

Git conflict detection cannot catch these behavioral incompatibilities.

## Architecture

```
Repository + PRs
      │
      ▼
Pin base and PR head SHAs
      │
      ▼
Generate candidate matrix (A, B, C, A+B, A+C, B+C)
      │
      ▼
Solari worker pool ──► isolated Git workspace
                       install + checks
                       Playwright verification
                       logs / screenshots / traces
      │
      ▼
Classify outcomes and detect cross-PR regressions
      │
      ▼
result.json + index.html report
```

## Why Solari is required

MergeLab runs arbitrary repository code (install scripts, tests, build tools,
browsers) for every candidate. Solari provides:

- **Isolation** — each candidate gets its own microVM, dependency state, and browser context.
- **Reproducibility** — the same pinned SHAs produce the same state in a clean environment.
- **Safety** — untrusted code never runs on the host.
- **Browser proof** — each candidate can expose a port and be exercised by a cloud browser.

## Prerequisites

- Node.js 20+
- A Solari API key (`SOLARI_API_KEY`)
- (Optional) A GitHub token for higher rate limits (`GITHUB_TOKEN`)

```bash
cp .env.example .env
# edit .env with your SOLARI_API_KEY
```

## Install

```bash
npm install
```

## Run

```bash
npm start -- \
  --repo https://github.com/example/mergelab-fixture \
  --prs 21,22,23 \
  --config ./mergelab.config.json
```

### Options

| Flag | Description |
|---|---|
| `--repo` | Public GitHub repository URL (required) |
| `--prs` | Comma-separated list of 2–3 PR numbers (required) |
| `--config` | Path to `mergelab.config.json` (required) |
| `--base-sha` | Explicit immutable base commit |
| `--mode` | `pairwise` (default) or `selected` |
| `--combination` | Explicit candidate such as `21+22` |
| `--concurrency` | Maximum simultaneous workers (default `2`) |
| `--output` | Report directory (default `./mergelab-results`) |
| `--keep-sandboxes` | Retain environments for debugging |
| `--no-ai` | Omit AI explanation |

## Fixture repository

A ready-made fixture lives in [`fixture/`](fixture/). Patch files for the three
PRs live in [`patches/`](patches/). PR A and PR B combine to break the checkout
UI. See [`fixture/README.md`](fixture/README.md) for how to publish the fixture
to GitHub and run MergeLab against it.

## Expected matrix

```text
✓ PR #21             compatible
✓ PR #22             compatible
✓ PR #23             compatible
✗ PR #21 + PR #22    cross_pr_regression
✓ PR #21 + PR #23    compatible
✓ PR #22 + PR #23    compatible
```

## Evidence and trust model

- Verdicts come from deterministic checks, not from the model.
- AI only narrates evidence it can reference by candidate ID and log line.
- Base and PR head SHAs are pinned and recorded in `result.json`.
- Every command's exit code, stdout, stderr, and duration are captured.
- Browser failures include screenshots, console errors, and page errors.
- All secrets are redacted from logs and artifacts.

## Security and cleanup

- GitHub access is read-only; MergeLab never pushes, merges, approves, or comments.
- Repository scripts run only inside Solari sandboxes.
- Worker sandboxes are killed by default (`--keep-sandboxes` overrides this).
- Cleanup runs in a `finally` path and a nonzero exit code is returned if mandatory
  cleanup fails.

## Cost / concurrency note

Each candidate provisions a Solari sandbox and optionally a browser session.
Pairwise mode with 3 PRs creates 6 candidates. Use `--concurrency` to bound
parallel spend.

## Limitations

- V0 tests only individual and pairwise combinations; higher-order interactions
  are not covered.
- Public repositories only; private repos and GitHub Apps are not supported.
- Passing configured checks does not prove total compatibility.
- AI explanations are evidence-backed but may be incomplete.

## Project layout

```text
examples/mergelab/
├── src/              # MergeLab engine
├── tests/            # Unit tests
├── verification/     # Playwright verification specs
├── fixture/          # Example target repository with PR branches
├── proof/            # Sample sanitized run output
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── mergelab.config.example.json
```

## Run tests

```bash
npm test
npm run typecheck
```

## Roadmap

- GitHub App and private repository support
- Webhook-triggered checks
- Dependency-graph pruning
- Higher-order combinations
- Solari snapshot caching
- Bidirectional merge-order testing
- Proposed compatibility patches
- GitHub status checks and comments

## License

MIT
