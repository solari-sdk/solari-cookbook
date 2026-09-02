# Repro (Milestone 2A)

Repro now turns a public GitHub issue into a bounded, structured reproduction plan. It fetches the issue through GitHub's public REST API, invokes the locally installed OpenAI Codex CLI with a strict output schema, validates the generated commands with a basic safety guardrail, and prints the plan for review. Milestone 2A does not execute generated plans.

The Milestone 1 execution path remains available: it can clone a public repository into an isolated Solari sandbox and run one user-supplied command there.

## Install

```bash
cd examples/repro-ts
npm install
```

## Plan from a GitHub issue

Planning requires the `codex` CLI authenticated with your ChatGPT account. It does not require `OPENAI_API_KEY`.

```bash
codex login
codex login status
npm start -- https://github.com/psf/requests/issues/6102
```

For machine-readable output:

```bash
npm start -- https://github.com/psf/requests/issues/6102 --json
```

Optional planning environment variables:

- `GITHUB_TOKEN` raises GitHub API rate limits for public issue fetching.
- `REPRO_CODEX_MODEL` overrides the model used by `codex exec`. When unset, Codex uses its authenticated default.

Repro invokes an ephemeral `codex exec` request in a temporary directory with a read-only sandbox, with at most one fresh regeneration if a parseable plan fails content validation. The issue context is passed over stdin, and the generated plan is captured with Codex's output-schema and output-last-message flags. Before accepting a plan, Repro requires every generated command to be single-line, checks it independently with `sh -n -c` without executing it, then applies its dangerous-command guardrails. Multiline commands and heredocs are not supported in Milestone 2A. Repro never reads or prints Codex authentication tokens. Pull requests and issue comments are not supported in this milestone.

## Run a command in Solari (Milestone 1)

Sandbox execution requires a Solari API key:

```bash
export SOLARI_API_KEY="your_solari_api_key"
npm start -- https://github.com/psf/requests "python3 --version"
```

The command is intentionally passed to `sh -lc`, so quote it as one local CLI argument.

## Local checks

```bash
npm run typecheck
npm test
```
