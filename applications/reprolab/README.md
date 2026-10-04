# ReproLab

ReproLab is a deterministic reproduction runner for one bug class: a web page
exports a CSV containing a textual identifier, and LibreOffice Calc may
interpret that identifier differently. V1 supports exactly one recipe:
`csv_identifier_libreoffice`.

It is not an arbitrary QA agent. It does not use an LLM, OCR, screenshot
interpretation, autonomous navigation, or bug fixing.

## Why all three Solari environments are used

- **Browser** performs the real export workflow and returns the downloaded bytes.
- **Sandbox** independently hashes and parses those exact bytes, proving what the
  artifact contains before any desktop application sees it.
- **Desktop** opens the same bytes in real LibreOffice Calc and reads the selected
  cell through the machine clipboard. `xclip` corroborates the value when present.

The Browser download is canonical. ReproLab computes its SHA-256 once and requires
the Sandbox and Desktop hashes to match. Screenshots are supporting evidence only.

## Verdicts

- `CONFIRMED`: every required gate passes, the raw CSV equals `expected_text`, and
  the desktop observation equals the declared `known_failure_text`.
- `NOT_REPRODUCED`: every gate passes and LibreOffice preserves `expected_text`.
- `INCONCLUSIVE`: evidence is missing, hashes differ, observations disagree, or an
  unexpected third value appears.

Verdicts are ordinary deterministic code in `reprolab/verdict.py`.

## Install

```bash
cd applications/reprolab
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

Set the key in your shell without committing it:

```bash
read -s "SOLARI_API_KEY?Solari API key: "
export SOLARI_API_KEY
echo
```

Alternatively, place `SOLARI_API_KEY=...` in an ignored `.env` and source it
before running. ReproLab does not copy the key into evidence.

## Run tests

```bash
python -m unittest discover -s tests -v
python -m compileall -q reprolab tests
ruff check reprolab tests
```

Tests require no Solari credentials.

## Run the live demo

The demo uses a deterministic in-browser fixture that exports:

```csv
account_code,customer,amount
001234,Northstar Labs,250.00
```

Run:

```bash
python -m reprolab demo
```

Or provide the versioned V1 spec shape shown in `run-spec.example.json`:

```bash
python -m reprolab run --spec run-spec.example.json
```

The command prints the verdict and evidence-bundle path. Every created Browser,
Sandbox, and Desktop is registered in a cleanup ledger and released or destroyed
in `finally` blocks.

## Known V1 limitations

- One recipe only: CSV textual identifier → LibreOffice Calc.
- The export control is the recipe's fixed `#export` selector.
- The target page must satisfy an exact title plus required body text assertion.
- Desktop observation requires the standard Solari image, LibreOffice, `xdotool`,
  and the known Calc Name Box shortcut.
- Only one accepted failure signature is allowed per run spec.
- No replay, authentication UI, proxies, CI integrations, or polished product UI.
