# GoblinQA 👹

> **Ship your app to AI users before shipping it to humans.**

GoblinQA releases autonomous synthetic users into a product and asks them to accomplish a goal in real, isolated cloud browsers. It shows where they succeed, fail, become confused, or discover friction—and ties every meaningful finding to browser evidence.

**Project status:** Milestone 0 is in progress. The immediate goal is one real, recorded Solari browser controlled by the GoblinQA runtime through the Solari TypeScript SDK. The swarm, reporting, and Fix Goblin described below are planned, not yet implemented.

## The problem

Traditional end-to-end tests are excellent at answering:

> Does the workflow we specified still work?

But developers supply the path: click this selector, fill this field, expect this result. Real users do not receive that script. They misread labels, navigate backward, refresh at awkward moments, retry actions, explore side paths, abandon flows, and use different devices or interaction styles.

GoblinQA asks a different question:

> Can different users figure out and complete the intended goal on their own?

## What GoblinQA does

```text
URL + Goal
    → autonomous Goblins
    → isolated Solari browser sessions
    → real interaction
    → success/failure evidence + session replays
    → issue clustering
    → Fix Goblin in a Solari Sandbox
    → patch + preview
    → same failing Goblin reruns
    → before/after verification
```

The full target swarm is **20 autonomous synthetic users**. That number matches the 20 concurrent browser sessions available in the Solari Starter environment, while still being small enough for each run to remain inspectable. During ordinary development, GoblinQA will use far fewer sessions.

## Current, next, and vision

| Horizon | Scope |
| --- | --- |
| **Current — Milestone 0** | Prove one recorded browser session from the GoblinQA runtime using `@solarisdk/browser`, including replay retrieval and complete cleanup. |
| **Next** | Build one autonomous Goblin, then run three distinct behavioral personas and produce structured evidence. |
| **Vision** | Run the 20-Goblin swarm, cluster repeated failures, let Fix Goblin patch a reproducible bug in `@solarisdk/sandbox`, and rerun the same Goblin to verify the result. |

The previously verified Solari MCP browser session established that the development connection works. Milestone 0 is separate: it proves that GoblinQA's own runtime can use the SDK directly.

## Architecture

```text
                    ┌──────────────────────────────┐
URL + goal ────────▶│ Goblin runner + LLM decisions│
                    └──────────────┬───────────────┘
                                   │
                         @solarisdk/browser
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │ Isolated recorded browser    │
                    │ actions, outcome, replay     │
                    └──────────────┬───────────────┘
                                   │ reproducible failure
                                   ▼
                    ┌──────────────────────────────┐
                    │ Fix Goblin                   │
                    │ @solarisdk/sandbox           │
                    │ inspect → patch → test       │
                    └──────────────┬───────────────┘
                                   │ preview URL
                                   └──────▶ same Goblin reruns
```

## The 20 Goblins

The names make the report memorable; the behaviors make it useful. Each persona represents a legitimate class of functional failure or product friction.

| Persona | Behavior | Designed to expose |
| --- | --- | --- |
| **Normal User** | Follows the most apparent path at a steady pace. | Baseline task success and ordinary workflow defects. |
| **Speedrunner** | Chooses the fastest apparent route and minimizes reading. | Weak safeguards, ambiguous primary actions, and race-prone flows. |
| **Confused User** | Makes plausible first-time-user mistakes when labels or navigation are unclear. | Ambiguous copy, misleading hierarchy, and poor error recovery. |
| **Back Button Goblin** | Uses browser back and forward throughout the task. | Broken history, stale state, redirect loops, and lost progress. |
| **Double Clicker** | Occasionally activates actionable controls twice. | Missing idempotency, duplicate submissions, and accidental double navigation. |
| **Explorer** | Investigates nearby features while still pursuing the goal. | Side-path dead ends, inconsistent navigation, and unexpected state coupling. |
| **Refresh Goblin** | Refreshes during meaningful workflow transitions. | Non-persisted state, fragile sessions, and incomplete recovery. |
| **Literal User** | Interprets interface copy and instructions exactly as written. | Imprecise wording, contradictory guidance, and hidden assumptions. |
| **Impatient User** | Retries or changes approach when feedback appears slow. | Missing loading states, latency confusion, and unsafe retries. |
| **Bad Data Goblin** | Enters safe but malformed, incomplete, or boundary-case values. | Validation gaps, poor error messages, and inconsistent form state. |
| **Mobile User** | Uses a mobile-sized viewport and touch-oriented navigation. | Responsive layout failures, obscured controls, and mobile-only friction. |
| **Keyboard User** | Navigates and operates controls primarily with the keyboard. | Broken focus order, inaccessible controls, and keyboard traps. |
| **Abandoner** | Leaves a flow partway through and later attempts to resume. | Draft loss, unclear resumability, and abandoned-state bugs. |
| **Multi-tab Goblin** | Opens relevant pages in multiple tabs and switches between them. | Stale data, session conflicts, and cross-tab state synchronization bugs. |
| **New User** | Approaches the product without assumed domain or product knowledge. | Onboarding gaps, missing explanations, and weak discoverability. |
| **Power User** | Looks for efficient navigation, shortcuts, and direct manipulation. | Unnecessary friction, inconsistent shortcuts, and inefficient repeated work. |
| **Accessibility Goblin** | Uses semantic cues and keyboard-accessible paths and notes accessibility barriers. | Missing names, roles, focus visibility, and basic operability issues. |
| **Lost Goblin** | Recovers from deep links, error pages, or disorientation without a known home path. | Weak wayfinding, missing escape routes, and poor recovery navigation. |
| **Repeat User** | Repeats a completed or previously attempted workflow. | Residual state, duplication bugs, and non-repeatable flows. |
| **Chaos Goblin** | Combines a bounded set of safe behaviors such as refresh, back, retry, and exploration. | Interaction effects that isolated behaviors miss, without destructive or abusive testing. |

These personas are behavioral lenses, not replacements for device matrices, accessibility audits, load tests, or deterministic regression suites.

## Why Solari is essential

Each Goblin needs an isolated real browser, independent application state, controlled interaction, concurrency, and a replayable record. Solari Browser supplies that execution and evidence layer.

When a failure is reproducible, Fix Goblin eventually needs an isolated place to clone the repository, inspect files, execute commands, make a small patch, run tests, start the application, and expose a preview. Solari Sandbox supplies that repair environment.

The complete loop is deliberately simple:

```text
Browser       = observe reality
Sandbox       = modify software
Browser again = verify reality
```

GoblinQA's runtime will use `@solarisdk/browser` directly and, in the later Fix Goblin milestone, `@solarisdk/sandbox`. Solari MCP is useful development and debugging tooling for Codex; it is not a production dependency of GoblinQA.

## Why not Playwright?

GoblinQA does not replace Playwright or deterministic E2E testing. The two answer different questions.

| Deterministic E2E test | GoblinQA |
| --- | --- |
| Developer supplies exact steps and assertions. | Developer supplies a URL and user intent. |
| Verifies a known path repeatedly. | Lets an agent discover a path independently. |
| Best for regression confidence. | Best for behavioral variation, discoverability, and unexpected friction. |

Strong products should use both. Findings from GoblinQA may become deterministic regression tests after they are understood.

## Safety boundaries

GoblinQA is only for products the user owns or has explicit permission to test. It is behavioral product testing—not load flooding, DDoS testing, credential attacks, exploitation, spam, unbounded crawling, or real purchasing.

Development runs intentionally limit concurrency. The 20-Goblin swarm is reserved for deliberate demonstrations or approved test runs.

## North star

A founder enters a URL and a goal, watches independent Goblins use the product, and learns about a real failure they did not know existed. Later, Fix Goblin repairs that failure and the same Goblin proves it is gone.

**How many Goblins can your product survive?**
