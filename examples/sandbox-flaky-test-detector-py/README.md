# FlakeProof (Python)

FlakeProof repeatedly runs each pytest test inside a disposable Solari
micro-VM, then labels the test `stable-pass`, `stable-fail`, `flaky`,
`timeout`, or `error`. It produces both Markdown evidence for a reviewer and
JSON for CI or later automation.

The project under test and its installation commands execute remotely in the
sandbox, not on your workstation. The VM is destroyed in `finally`, including
when collection or a test fails.

## Why this is useful

A retry can make CI green while hiding nondeterminism. FlakeProof preserves all
attempts and reports mixed outcomes explicitly, helping maintainers separate a
real regression from an unreliable test.

## Run the deterministic demo

The built-in suite contains one stable pass, one stable failure, and one test
that alternates between passing and failing.

```bash
cd examples/sandbox-flaky-test-detector-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
python main.py
```

PowerShell:

```powershell
$env:SOLARI_API_KEY = "slr_live_..."
python main.py
```

Expected summary:

```text
summary: {"error": 0, "flaky": 1, "stable-fail": 1, "stable-pass": 1, "timeout": 0}
```

Reports are written to `output/flakeproof-report.json` and
`output/flakeproof-report.md`.

## Scan a public pytest repository

```bash
python main.py \
  --repo https://github.com/owner/repository \
  --runs 5 \
  --max-tests 20
```

Common `requirements.txt`, `pyproject.toml`, and `setup.py` projects are set up
automatically. For a different workflow, provide a command without shell
operators:

```bash
python main.py \
  --repo https://github.com/owner/repository \
  --install-command "python -m pip install -e .[test]"
```

Use `python main.py --help` for run limits, per-test timeouts, and output
options.

## Local tests

These tests exercise URL validation, classification, result extraction, and
report generation without using Solari credits:

```bash
pytest -q
```

## Current scope

- Public GitHub repositories using pytest
- At most 50 collected tests and 10 repetitions per invocation
- One isolated sandbox per scan; repeated attempts share that disposable VM
- Read-only analysis: FlakeProof does not modify the source repository or open
  issues automatically

Source: [`main.py`](main.py)
