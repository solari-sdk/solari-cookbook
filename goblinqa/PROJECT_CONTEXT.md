# GoblinQA: Durable Product Context

## Purpose

GoblinQA is an AI-native behavioral product testing system. It releases autonomous synthetic users—Goblins—into a real product, gives each one a goal and a behavioral profile, and observes whether they can figure out the interface without being told the correct workflow.

The durable product loop is:

```text
URL + Goal
→ Goblin swarm
→ behavioral evidence
→ reproducible failure
→ Fix Goblin
→ patch
→ same Goblin reruns
→ before/after verification
```

The value is not that AI can click buttons. The value is that a population of independent, goal-driven users may reveal functional and human-facing failures before real customers encounter them—and can later verify whether a repair changed reality.

## Product thesis

Traditional automated testing is strongest when the expected path is already known. Developers specify selectors, actions, inputs, and assertions, then run the same path consistently.

That leaves an important gap between a passing test suite and successful real-world use. Human users:

- misunderstand labels;
- take unexpected navigation paths;
- go backward or refresh;
- retry slow actions;
- abandon and resume;
- use multiple tabs, mobile layouts, or keyboard navigation;
- enter incomplete or unusual data;
- fail to discover features that technically work.

GoblinQA adds a behavioral layer immediately before real users. The user supplies intent rather than a script. Whether a Goblin can discover the workflow is itself part of the result.

GoblinQA complements unit, integration, and deterministic E2E tests. It does not replace them.

## Problem definition

Teams can know that an expected workflow works while still not knowing:

- whether a new user can find it;
- whether the interface communicates what to do next;
- whether common deviations preserve state;
- whether errors and latency provide enough feedback;
- whether the workflow behaves consistently across interaction styles;
- whether several apparently minor friction points combine into failure.

Manual usability testing is valuable but slow to arrange and difficult to repeat continuously. GoblinQA aims to make a varied, evidence-producing behavioral pass available on demand while keeping its conclusions inspectable.

## Target users

The initial audience is:

- startup founders and indie hackers preparing a launch;
- small product and engineering teams with limited QA capacity;
- frontend and product engineers shipping frequent workflow changes;
- AI product builders who need realistic browser interaction evidence;
- teams that already have scripted tests but want broader behavioral coverage.

The clearest initial use case is a team testing its own preview or staging environment before release.

## Why synthetic users matter

One autonomous agent provides a useful smoke test. A population provides behavioral contrast.

Different Goblins receive the same product goal but approach it with different tendencies. Their disagreement is informative: if the baseline user succeeds but refresh, keyboard, and confused users fail, the report points toward specific classes of state, accessibility, or communication problems.

Synthetic users are not equivalent to real users and must not be presented as such. They are a repeatable pre-user testing layer that can explore more behavioral variation than one deterministic path.

## Behavioral testing philosophy

GoblinQA should follow these principles:

1. **Give intent, not the correct path.** The goal describes the desired outcome without revealing which controls to use.
2. **Preserve independent behavior.** Personas influence decisions without scripting an exact failure.
3. **Observe actual product state.** Conclusions come from real browser interaction, not mocked navigation.
4. **Bound every run.** Each Goblin has limits on steps, time, scope, and permitted actions.
5. **Separate failure classes.** A software defect is different from a user who cannot discover a working feature.
6. **Prefer evidence over confident prose.** Reports must point back to actions, observations, and replayable sessions.
7. **Turn stable discoveries into regression tests.** GoblinQA finds unexpected behavior; deterministic tests should preserve understood fixes.

## The complete 20-Goblin system

The intended full swarm contains 20 autonomous users, aligned with the Solari Starter environment's 20 concurrent browser sessions. Routine development uses smaller runs; 20 is a deliberate demonstration or approved product test.

Each profile has a testing purpose:

| Persona | Behavioral lens | Primary risk area |
| --- | --- | --- |
| Normal User | Most apparent path at a steady pace | Baseline task completion |
| Speedrunner | Minimal reading and fastest apparent path | Safeguards, rushed choices, race conditions |
| Confused User | Plausible misinterpretation of unclear UI | Copy, hierarchy, recovery |
| Back Button Goblin | Frequent history navigation | History and state preservation |
| Double Clicker | Occasional repeated activation | Idempotency and duplicate actions |
| Explorer | Relevant side-path exploration | Navigation consistency and state coupling |
| Refresh Goblin | Refresh during transitions | Persistence and recovery |
| Literal User | Exact interpretation of interface language | Copy precision and hidden assumptions |
| Impatient User | Retries when feedback appears slow | Loading feedback and unsafe retries |
| Bad Data Goblin | Safe malformed and boundary inputs | Validation and form-state handling |
| Mobile User | Mobile viewport and touch-oriented use | Responsive and mobile interaction defects |
| Keyboard User | Keyboard-first operation | Focus, semantics, and keyboard traps |
| Abandoner | Partial completion followed by return | Drafts, resumability, abandoned state |
| Multi-tab Goblin | Parallel tabs within one task | Staleness and cross-tab synchronization |
| New User | No assumed product knowledge | Onboarding and discoverability |
| Power User | Efficient and repeat-oriented use | Workflow friction and shortcut consistency |
| Accessibility Goblin | Semantic and keyboard-accessible paths | Basic accessible operability |
| Lost Goblin | Recovery from deep links and error states | Wayfinding and escape routes |
| Repeat User | Repeats completed or attempted workflows | Residual state and repeatability |
| Chaos Goblin | Bounded combination of safe deviations | Interaction effects between behaviors |

The personas should remain understandable and diagnosable. Chaos must still be bounded. No persona authorizes destructive actions, security exploitation, abusive traffic, real purchases, or attacks on credentials.

## What the system evaluates

### Functional failures

Examples include:

- controls that do nothing or trigger the wrong action;
- crashes, server errors, and broken navigation;
- state loss after refresh, back navigation, or resume;
- duplicate submissions and non-idempotent actions;
- broken or inconsistent validation;
- stale state across tabs;
- layouts that prevent task completion.

### UX and product failures

Examples include:

- users cannot find a working feature;
- labels cause repeated wrong turns;
- feedback is absent while work is in progress;
- error recovery is unclear;
- the next action is hidden or visually de-emphasized;
- keyboard or mobile users cannot operate the same workflow;
- users abandon because the product appears stuck.

Reports must distinguish these categories. GoblinQA should not label every failed goal as a software bug.

## Evidence-first reporting

Every serious finding should connect to observable behavior. A useful report answers:

- Which Goblins were affected?
- What did each one observe and do?
- Where did their paths converge or differ?
- Was the failure reproduced?
- Which replay or artifact supports the conclusion?
- Was the goal impossible, undiscoverable, or merely abandoned within the run limit?

Avoid unsupported statements such as “the checkout may be confusing.” Prefer specific evidence such as “four of five affected Goblins searched Account before abandoning checkout; three replays show the same wrong turn.”

Evidence may include structured steps, observations, timestamps, final state, screenshots where useful, and recorded Solari session replays.

## Issue clustering

Twenty Goblins should not generate twenty duplicate issues. Findings should be grouped when they share a likely failure mechanism or behavioral pattern.

A cluster should preserve:

- a concise issue title and category;
- severity grounded in impact and reproducibility;
- affected and unaffected personas;
- minimal reproduction steps;
- evidence and replay references;
- uncertainty when similar symptoms may have different causes.

Clustering must not erase meaningful differences. For example, “checkout state disappears after refresh” and “checkout cannot be found on mobile” belong to different issue classes even if both prevent purchase completion.

## Fix Goblin

Fix Goblin begins only after GoblinQA has a reproducible software failure with adequate evidence. It is not a general autonomous coding system and should not attempt to repair subjective friction without a clear, approved change.

Its intended responsibilities are:

1. receive the repository, failure evidence, and reproduction steps;
2. create an isolated Solari Sandbox;
3. clone and inspect the codebase;
4. locate the probable cause;
5. create the smallest reasonable patch;
6. add or update a regression test when appropriate;
7. execute the relevant test suite;
8. start the repaired application and expose a preview;
9. return the patch, test results, and preview evidence.

Fix Goblin is incomplete until browser verification succeeds.

## Rerun verification

Compilation and tests are necessary evidence, but they do not prove that the original behavioral failure disappeared.

GoblinQA should send the same relevant Goblin—with the same goal and behavioral profile—through the repaired preview. The report then compares the original and rerun evidence:

```text
Before: Refresh Goblin failed; checkout state disappeared.
Patch:  State persistence changed and regression test passed.
After:  Refresh Goblin completed the same goal on the preview.
```

This closes the product loop: discover, reproduce, repair, rerun, verify.

## Why Solari

Solari is fundamental infrastructure, not a branding layer.

### Solari Browser: observe reality

Every Goblin requires:

- an isolated real browser session;
- independent cookies and application state;
- browser interaction through the runtime;
- controlled concurrency;
- recording and replay evidence;
- reliable lifecycle cleanup.

GoblinQA production code uses the Solari Browser SDK directly. Solari MCP is development and debugging tooling for Codex, not a production runtime dependency.

### Solari Sandbox: modify software

Fix Goblin eventually requires:

- isolated code execution;
- repository cloning and file inspection;
- command and test execution;
- safe patch development;
- a running development server;
- a public preview URL;
- explicit remote VM destruction after use.

The standalone Solari Sandbox SDK is the intended runtime interface.

### Solari Browser again: verify reality

The patched preview returns to the same environment that discovered the problem. The same Goblin reruns the same goal, producing comparable behavioral evidence.

```text
Browser       = observe reality
Sandbox       = modify software
Browser again = verify reality
```

## Product personality

GoblinQA should feel playful, slightly chaotic, fast, visual, and technically credible. The Goblin metaphor makes QA results memorable; it must never obscure the rigor of the evidence.

Avoid a childish fantasy aesthetic or generic enterprise dashboard. The tone should make testing approachable while remaining trustworthy to engineers.

## Visual direction

The most compelling screen is the live swarm: a high-information view of independent users moving through the same product, with visible running, passed, failed, and confused states.

Potential direction:

- dark or warm off-white base;
- terminal and developer-tool influences;
- restrained green, yellow, and red status colors;
- small distinctive Goblin identities;
- dense but legible evidence views;
- replay access close to every important finding;
- before/after comparison as the visual payoff.

The UI should remain simpler than the system it represents.

## Shareable survival score

The survival score translates a complex behavioral run into a memorable result:

```text
acme.example survived 17 / 20 Goblins
2 functional failures · 4 friction points
```

It can support shareable result cards and launch storytelling, but it must not become a vanity metric. The score should always lead to evidence, distinguish failure types, and disclose the tested goal and run conditions.

## Possible launch strategy

A focused launch can invite founders to submit products they own or are authorized to test. GoblinQA runs a bounded swarm, returns replay-backed findings, and—with permission—shares an anonymized or approved survival score.

This demonstrates the product through its output rather than through feature claims. A strong launch result is not maximum traffic; it is several founders asking to test again after receiving useful evidence.

## What success means

Early success looks like:

- external teams ask to run GoblinQA on their products;
- approved tests discover meaningful, previously unknown failures;
- findings are specific enough to reproduce and act on;
- replay evidence builds trust in the conclusions;
- teams rerun the same goals after changes;
- before/after verification demonstrates a real improvement.

Useful learning from five authorized products matters more than a broad feature set.

## North star

A founder enters a URL and a goal, watches several autonomous Goblins use the product, and one Goblin discovers a real problem the founder did not know existed. Later, Fix Goblin repairs it and the same Goblin proves the failure is gone.

Before adding a capability, ask:

> Does this make the core Goblin testing loop more useful, believable, or demonstrable?

If not, it should wait.

## Non-goals

GoblinQA is not initially:

- a replacement for unit, integration, deterministic E2E, accessibility, security, or load testing;
- an authentication, billing, team, or enterprise administration platform;
- a CI/CD integration suite, GitHub App, browser extension, or general developer platform;
- a large analytics warehouse or elaborate database product;
- a penetration testing, exploitation, credential attack, spam, crawling, or DDoS tool;
- a system for testing websites without ownership or explicit permission;
- an unbounded autonomous patching or deployment system.

The project should be built incrementally. The first proof is one recorded browser controlled by the GoblinQA runtime. Fix Goblin comes only after behavioral runs and evidence are reliable.
