# PatchProof

PatchProof helps open-source maintainers check whether a proposed fix addresses a reproduced bug by running the same reviewer-owned regression probe against two revisions in fresh Solari sandboxes.

## Problem and user

V1 serves one user: a maintainer reviewing a small Python bug fix. A green candidate test does not establish that the test detected the original bug. Today the maintainer checks out both revisions, prepares environments, copies a reproducer between them, interprets failures, and assembles evidence for review. Doing this with unfamiliar contributor code also exposes their workstation or requires a separate container/CI setup.

## Workflow and scope

The maintainer writes a small JSON experiment: public GitHub repository, two full commit hashes, zero to five setup commands, and one identical regression probe with explicit failure and success witnesses. `plan` validates it locally without spending credits. `run` starts the baseline in a fresh microVM. Only a baseline with the expected exit code AND failure witness permits a second, fresh candidate VM. The result is a local JSON receipt and readable HTML report with output, timings, environment, input digest, and cleanup status.

For a deterministic first run, a clearly labeled fixture supplies a buggy and corrected cache implementation directly. It tests the same orchestration and remote command path without GitHub or package downloads. Offline simulation is separately labeled and never qualifies as real Solari evidence.

## Acceptance criteria

- Baseline expected failure plus candidate exit zero AND success witness yields `verified` only after both resources are confirmed released.
- Baseline success yields `not_reproduced`; an expected candidate failure yields `still_failing`; unknown output, setup failure, wrong revision, timeout, cancellation, creation failure, and cleanup uncertainty yield `inconclusive`.
- A receipt binds the complete manifest and identical probe to the run. It is an integrity record, not a cryptographic attestation of honest guest execution.
- No repository commands execute on the maintainer's computer. No credentials, environment inheritance, volumes, browser sessions, or desktop sessions enter the guest.
- At most two sequential 1-vCPU/2048-MiB base sandboxes. Default 120-second wall limit per session, maximum 300; command timeout default 30 seconds, maximum 120. Cleanup has its own bounded allowance.
- Reusing an occupied output directory refuses a second run. To retry intentionally, use a new directory. No implicit cached verdicts.
- Invalid manifests fail before allocating a VM. Local test suite requires no API key and no Solari credit.

## Alternatives and differentiation

CI matrices, containers, git worktrees, and manual reproduction can perform this experiment. Solari is not uniquely necessary: its practical advantage is disposable Linux execution without local Docker, workflow permissions, or repository secrets, including ad hoc reviews outside a configured CI pipeline. PatchProof contributes the two-sided oracle, provenance, cleanup accounting, and shareable evidence. This is not a new isolation technology or a replacement for a test suite.

Research and rejected concepts are in [OPPORTUNITIES.md](OPPORTUNITIES.md). CSV consumer roundtrip was compelling but desktop entitlement puts its reliable demo outside the known free-tier constraints. README replay and generic website testing have weaker differentiation.

## Architecture, security, reliability

One TypeScript CLI, one fixed Python guest runner using the standard library, one official SandboxClient adapter, and local files. See [ARCHITECTURE.md](ARCHITECTURE.md). Treat manifests, guest output, and dependency code as untrusted. Validate at boundaries, never interpolate commands into a local shell, escape report text, suppress terminal control characters, and record ambiguous failures honestly. Remote code can access the internet: no verified provider egress policy exists. Do not run malware, private data, or code you have not reviewed for abusive behavior. A malicious revision can forge probe results; this is regression evidence, not an adversarial certification system.

## Cost and measurable value

Count actual sessions, elapsed execution, and cleanup outcomes. Show estimated requested-compute cost using published rates with clear exclusions; never claim billed cost. Stop after an unreproduced baseline. No browser, proxy, captcha, LLM, queue, database, or paid desktop dependency. Measure time from start to receipt; do not invent minutes saved or users. Success means a new maintainer can run the fixture, inspect both sides, and replace it with their own pinned public repository experiment.

## Demo and validation

The fixture reproduces stale cache reads after deletion, then demonstrates invalidation in the candidate. A second fixture intentionally leaves the bug unfixed. Simulated infrastructure failures prove that an HTTP or cleanup error never becomes a green result. Record a genuine Solari run only when a configured key is available; mark it pending until then. CLI and issue templates provide a route for external feedback, not claims of traction.

## Non-goals and next steps

No automatic code repair, generated tests, private repositories, secret injection, GitHub comment bot, GUI, browser agents, language matrix, snapshots, or hostile-code attestation. Add PR integration only after maintainers use the CLI and the evidence model survives real feedback. Pinning a provider template digest and dependency artifacts would improve reproducibility beyond V1's reported runtime and immutable Git revisions.
