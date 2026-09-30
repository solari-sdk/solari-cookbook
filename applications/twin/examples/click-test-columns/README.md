# pallets/click: `test_custom_parser` fails in a narrow terminal

No upstream issue was found for this one. It is a found-in-the-wild failure on [pallets/click](https://github.com/pallets/click) (17.8k stars) at `06b2a67` (main): `tests/test_commands.py::test_custom_parser` fails whenever the `COLUMNS` environment variable is small, and passes with a wide or unset one. Someone with a 40-column terminal (or a CI job that exports `COLUMNS`) sees a red test that a maintainer cannot see.

The test builds an `optparse.OptionParser` and compares its `format_help()` output with fixed, 78-column-wrapped text. `optparse` sizes its help to `COLUMNS`, so the wrapping (and the test) changes with it.

| File | What it is |
|---|---|
| `narrow-40.json` | capsule from a reporter with `COLUMNS=40`: the test fails |
| `wide-120.json` | capsule from a maintainer with `COLUMNS=120`: the whole file passes |
| `replay.txt` | `twin replay narrow-40.json` on Solari, recorded 2026-09-29 |
| `bisect.txt` | `twin bisect narrow-40.json --good wide-120.json` on Solari, recorded 2026-09-29 |
| `fix.patch` | candidate fix for the test |
| `verify.txt` | `twin verify narrow-40.json --patch fix.patch` on Solari, recorded 2026-09-29 |

This is a Python project: uv (`uv.lock`), Python 3.13.12, uv 0.11.3, clean working tree at the commit. Capsules were captured with `LANG=C.UTF-8`, no `LC_*`, `NO_COLOR=1`, and `--include-env COLUMNS` (twin records most variable values by name only; `COLUMNS` is not in its shared-value list, so the reporter opts in to sharing it).

## What happened

Capture:

```sh
uv run --frozen pytest -q -p no:cacheprovider tests/test_commands.py
```

`twin diff wide-120.json narrow-40.json` shows a single difference: `COLUMNS  120 -> 40`.

| Command | Verdict | Wall time |
|---|---|---|
| `twin replay narrow-40.json` | REPRODUCED (3 of 3 attempts, same signature) | 20 s |
| `twin bisect narrow-40.json --good wide-120.json` | minimal difference `COLUMNS=40` | 25 s |
| `twin verify narrow-40.json --patch fix.patch` | FIXED (3 of 3 attempts pass) | 19 s |

`fix.patch` passes `optparse.IndentedHelpFormatter(width=78)` (optparse's own default for an 80-column terminal) so the expected text no longer depends on the terminal. The file passes locally with `COLUMNS` set to 40, 80, 200 and unset.

## Run it yourself

```sh
export SOLARI_API_KEY=...
twin replay examples/click-test-columns/narrow-40.json
twin bisect examples/click-test-columns/narrow-40.json --good examples/click-test-columns/wide-120.json
twin verify examples/click-test-columns/narrow-40.json --patch examples/click-test-columns/fix.patch
```
