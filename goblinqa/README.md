# GoblinQA 👹

> Ship your app to AI users before shipping it to humans.

GoblinQA is a goal-driven, autonomous QA prototype built with TypeScript, Gemini, and Solari Browser. Give it a website URL and a task: AI personas observe the interface, choose actions, attempt multi-step workflows, and report task completion, failures, navigation friction, and their decisions.

The implementation supports a catalog of **20 behavioral personas**, selectable in groups of 1–20. Runs are sequential, with a separate recorded browser session for each persona. It is a command-line application—not a dashboard or an autonomous code-repair system.

## Approach

```text
URL + Goal
    → select personas
    → independent Solari sessions, one at a time
    → Observe → Decide → Validate → Act
    → per-persona results, screenshots, replay, and video
    → aggregate QA report and candidate issue clusters
```

1. **Observe:** collect visible page text and interactive-element references.
2. **Decide:** Gemini chooses one action using the goal, persona instructions, observation, and prior actions.
3. **Validate:** reject malformed decisions, with one retry for invalid model output.
4. **Act:** use the Solari Browser SDK to click, type, scroll, navigate back/forward, refresh, or wait. The agent can finish or report failure.
5. **Record:** retain observations, redacted typing actions, timestamped screenshots, findings, session IDs, replay artifacts, and video status.
6. **Aggregate:** compare outcomes and group candidate issues while preserving each occurrence and its evidence.

All personas share one runner. The runtime uses `@solarisdk/browser` directly; MCP is development tooling, not a production dependency. Runs default to eight decision steps per persona, configurable up to twenty.

A provider outage is not a product bug. Model, browser, screenshot, replay, video, and cleanup failures are recorded separately from observed product findings. Cleanup attempts browser release and client closure; if a session cannot be confirmed released, further launches stop and remaining result slots explain why they were not launched.

## Personas

| Persona | Behavioral focus |
| --- | --- |
| Normal User | Obvious labels and the ordinary path |
| Confused User | Unclear terminology and reasonable error recovery |
| Speedrunner | The shortest reasonable safe path |
| Back Button Goblin | History navigation and retained progress |
| Explorer | Relevant navigation choices and dead ends |
| Refresh Goblin | State and guidance after a safe refresh |
| Literal User | Whether labels mean what they say |
| Impatient User | Loading feedback and visible progress |
| Bad Data Goblin | Harmless formatting mistakes and validation recovery |
| Abandoner | Leaving and resuming an unfinished form |
| New User | Onboarding and missing domain explanations |
| Power User | Visible defaults and efficient controls |
| Lost Goblin | Wayfinding and recovery from disorientation |
| Repeat User | Revisiting unfinished work without duplicate submissions |
| Chaos Goblin | A bounded combination of safe deviations |
| Help Seeker | In-workflow help and explanations |
| Careful Reader | Consistency across instructions and labels |
| Search First User | Relevant workflow-specific search and filters |
| Form Reviewer | Required fields and pre-submit review |
| Skeptical User | Explicit confirmation before declaring success |

These are behavioral instructions, not scripted journeys or guarantees that every behavior will occur. They use the current action vocabulary; device emulation, keyboard-only operation, and multi-tab control are not implemented.

## Setup

Requirements: Node.js 22+, a Solari API key, a Gemini API key, and permission to test the target website.

```bash
npm install
cp -n .env.example .env
```

Fill in `SOLARI_API_KEY` and `GEMINI_API_KEY` in your local `.env`. Do not commit credentials. The configured model defaults to `gemini-3.7-flash`; set `GEMINI_MODEL` to a model available to your account if necessary.

For an authorized sandbox, set `GOBLINQA_AUTHORIZED=true`. The SMTR login adapter resolves the allowlisted `SMTR_TEST_PASSWORD` at execution time through a secret reference, rather than sending its value to Gemini.

## How to run and test

Start with one browser for normal debugging:

```bash
GOBLIN_COUNT=1 npm start -- "https://example.com" \
  "Confirm the page is titled Example Domain."
```

Use your authorized target for real workflow testing. The default is five personas; use no more than three for feature tests and five for integration tests:

```bash
GOBLINQA_AUTHORIZED=true GOBLIN_COUNT=3 npm start -- "https://your-sandbox.example" \
  "Create one synthetic test request and report anything preventing completion."
```

For a deliberate, authorized 20-persona demonstration:

```bash
GOBLINQA_AUTHORIZED=true GOBLINQA_LARGE_RUN_AUTHORIZED=true GOBLIN_COUNT=20 \
  npm start -- "https://your-sandbox.example" "Your authorized test goal"
```

This can create up to twenty separate test records if the goal involves creating a record. It uses twenty sequential sessions, not twenty concurrent sessions. Runs above five require the additional large-run opt-in.

| Setting | Purpose |
| --- | --- |
| `GOBLIN_COUNT` | 1–20 personas; default 5, selected in catalog order |
| `GOBLIN_MAX_STEPS` | 1–20 decisions per persona; default 8 |
| `GEMINI_MODEL` | Gemini model selection |
| `GOBLINQA_AUTHORIZED` | Explicit permission acknowledgment for non-example targets |
| `GOBLINQA_LARGE_RUN_AUTHORIZED` | Additional opt-in for more than five personas |

Run local checks:

```bash
npm run typecheck
npm test
```

The automated tests use simulated runner results to check persona selection, resource guards, sequential orchestration, failure isolation, artifact references, and clustering. They do not prove live Solari/Gemini behavior. For live verification, inspect the generated report and actual screenshots, replay, and video from your authorized run.

`npm run milestone:6 -- "<URL>" "<GOAL>"` is equivalent to `npm start`. Earlier milestone commands remain available with their original run sizes.

## Results and evidence

Runs write to `artifacts/milestone-6/<unique-run-id>/`:

```text
<persona-id>.json
<persona-id>.webm
<persona-id>.replay.ndjson
screenshots/<persona-id>/step-01.png
aggregate-report.json
```

Each persona result includes the goal, completion status, failure type, observations, decisions, findings, session ID, evidence paths, and cleanup status. Artifact save errors are explicit; an expected path alone does not mean a file was produced.

The aggregate report contains per-persona outcomes, shared and unique findings, runtime failures, and issue clusters. Clustering uses category, observed URL, and conservative title similarity. Severity is provisional; a candidate cluster is not proof of a shared root cause, and an unreported issue does not mean another persona was unaffected.

Recordings, screenshots, replay URLs, and reports can contain application data. Artifacts are ignored by Git. Review and sanitize evidence before publishing it.

## Working on the project

Start with [AGENTS.md](AGENTS.md) for implementation constraints, milestone order, SDK lifecycle requirements, resource limits, and safety rules. Give that file to any coding agent working on GoblinQA. [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) describes the longer-term product direction; it is not a list of implemented features.

The main code lives in:

- `src/goblin/personas.ts` — persona catalog.
- `src/goblin/brain.ts` — model instructions and decision validation.
- `src/goblin/runner.ts` — shared browser loop and evidence capture.
- `src/goblin/swarm.ts` — selection, orchestration, aggregation, and persistence.
- `src/goblin/clusters.ts` — candidate issue grouping.
- `src/milestone-6.ts` — current CLI entry point.

Keep changes focused on the core testing loop. Test only owned or explicitly authorized websites, use synthetic data, and avoid destructive actions, credential attacks, real purchases, spam, and unrelated application areas. For SMTR, stay in the authorized Requestor sandbox workflow.

GoblinQA complements deterministic end-to-end tests: those verify a specified path; GoblinQA explores whether different synthetic users can discover and complete the goal.
