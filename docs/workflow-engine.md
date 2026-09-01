# Reusable workflow execution model

The workflow layer is intentionally declarative and bounded. It coordinates trusted project actions; it does not evaluate user-supplied Python, JavaScript, expressions, SQL, or shell commands.

## Playbooks

A `Playbook` is a versioned named preset composed of uniquely identified steps. Steps name an action from an explicit application-provided action registry and may declare dependencies, a bounded condition, retry count, a fallback action, and a human-review gate. `PlaybookRegistry` stores reusable presets without credentials or private targets.

## Execution

`WorkflowEngine` executes the dependency graph in ready levels. Independent ready steps may run concurrently up to the configured worker bound. Each step receives copied workflow inputs, prior outputs, and its declared dependency outputs. This allows reproducible pivot chains without mutable hidden state.

Conditions are limited to `truthy`, `falsey`, `eq`, and `ne` checks over prior outputs. The engine never calls `eval` or interprets source-controlled expressions. Retry counts are bounded by the schema. A failed primary action can invoke one explicitly named fallback action. A failed step without a successful fallback terminates the workflow with an inspectable trace.

A step marked `requires_review` pauses the run before mutation until the caller supplies that step ID in the approved set. Review is an execution boundary, not a UI-only convention.

## Re-run, comparison and batch work

A completed/prior run retains its original input mapping. `rerun` executes the same playbook against a defensive copy of those inputs. `diff_workflow_runs` reports changed step outputs without erasing either run. `run_batch` applies one playbook to multiple targets with bounded concurrency and independent run state.

## Queue and priorities

`PriorityWorkflowQueue` is an in-process deterministic priority queue suitable for the single-node demo. Lower numeric priority is served first and FIFO order is preserved within equal priority. It deliberately does not claim durable distributed queuing; the server scaling design defines the future durable lease/worker boundary.

## Triggers

`WorkflowTrigger` provides declarative schedule, event, and source-health trigger matching. Schedule triggers use explicit minute intervals and timezone-aware last-run timestamps. Event and source-health triggers match fixed fields and status sets. Trigger evaluation creates no background daemon by itself: server/static callers decide when to evaluate triggers, which keeps scheduling infrastructure separate from workflow semantics.

## Security and provenance

Workflow definitions must not contain provider credentials, cookies, private keys, or hidden source inventory. Actions that execute untrusted/generated parsing logic should delegate to Solari Sandbox rather than the host workflow process. Production/shared deployments should persist run IDs, actor/review state, action versions, timing, and artifacts so results remain reproducible and auditable.
