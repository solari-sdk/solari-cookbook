# Proof

Raw results from live runs against real Solari sandboxes and the Claude API.

## `env-repair.jsonl`

Nine runs — three arms, three attempts each — on the `env-repair` task, where a
wrong choice damages installed Python packages *and* `/etc/appconf/settings.ini`.
One JSON object per line, so every figure in the README can be recomputed
without running this code:

```bash
python3 -c "
import json, statistics, collections
runs = [json.loads(l) for l in open('env-repair.jsonl')]
by = collections.defaultdict(list)
for r in runs: by[r['arm']].append(r)
for arm, rs in by.items():
    print(arm, 'n=%d' % len(rs),
          'solved=%d' % sum(r['solved'] for r in rs),
          'median_cost=%.3f' % statistics.median(r['cost'] for r in rs),
          'rewinds=%d' % sum(r['rewinds'] for r in rs))
"
```

Each record carries the arm, the task, whether the task's own verifier passed,
turns, tool calls, input and output tokens, estimated cost, rewinds, wall-clock
seconds, and any error.

## What is deliberately absent

No session ids, no snapshot ids, no API keys. `tests/test_evidence.py` asserts
that a written results file contains none of `SOLARI_API_KEY`, `ANTHROPIC_API_KEY`,
`slr_live_`, or `sk-ant-`.

## What is not here

An earlier sweep on the `ledger-migration` task was discarded rather than
committed. All three arms shared a single system prompt naming `checkpoint` and
`rewind`, so the arms lacking those tools were graded on instructions they could
not follow. Publishing it would have meant publishing a comparison known to be
unfair. The harness now builds a prompt per arm, and a test enforces that no
prompt names a tool its arm does not have.
