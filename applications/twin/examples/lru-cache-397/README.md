# node-lru-cache#397: a buried package version that breaks a fresh install

[isaacs/node-lru-cache#397](https://github.com/isaacs/node-lru-cache/issues/397) (fixed in 11.3.2, the day it was opened) reports that `lru-cache@11.3.0` has a top-level `await` in its ESM build. Anything that `require()`s it, such as `jsdom`, throws `ERR_REQUIRE_ASYNC_MODULE`. Reporters used jsdom, vitest and mocha. The project replayed here is [cure53/DOMPurify](https://github.com/cure53/DOMPurify) at commit `883ac15`, whose jsdom tests reach `lru-cache` through `jsdom` and `@asamuzakjp/dom-selector`.

The story: an install from the committed lockfile passes. A fresh install on 2026-04-06 resolved `lru-cache@11.3.0` and failed, so a maintainer and a user see different results from the same commit.

| File | What it is |
|---|---|
| `good.json` | `npm ci` from the committed lockfile: `npm run test:jsdom` passes |
| `bad.json` | a fresh install of what npm resolved that morning: the same command fails with `ERR_REQUIRE_ASYNC_MODULE` |
| `replay.txt` | `twin replay bad.json --keep`: `REPRODUCED`, 3 of 3 |
| `bisect.txt` | `twin bisect bad.json --good good.json` |
| `fix.patch` | a real fix: a scoped `overrides` entry in `package.json` and the refreshed lockfile |
| `verify.txt` | `twin verify bad.json --patch fix.patch`: `FIXED` |
| `verify-bogus.txt` | the same with a documentation-only patch: `STILL FAILING` |
| `mcp.txt`, `claude-session.txt` | the same loop driven over MCP, by a script and by a real Claude Code session |

Both capsules are from the same commit, with Node 24.15.0 and npm 11.12.1, and 705 installed Node packages each. `twin diff good.json bad.json` lists 33 packages whose version differs.

## How the capsules were made

```sh
# good: the maintainer's install, from the lockfile
npm ci
twin capture --yes -o good.json -- npm run test:jsdom

# bad: a fresh install, as it resolved just after lru-cache@11.3.0 was published
rm -rf node_modules
npm install --no-package-lock --before=2026-04-06T01:00:00Z
twin capture --yes -o bad.json -- npm run test:jsdom
```

## Replay reproduces it

`twin replay bad.json --keep` installs from the lockfile, then compares the machine's installed packages with the versions the capsule recorded. 32 differ, so twin installs them at the recorded versions in one step (`pin 32 packages to the capsule's versions`) before it runs the command:

```text
  ✓ install dependencies (npm ci)  9.7s
  ✓ pin 32 packages to the capsule's versions (@asamuzakjp/css-color@5.1.5, ...)  5.7s
Attempts
  1  FAIL exit 1  exit1:3c9267cd7d019116
  2  FAIL exit 1  exit1:3c9267cd7d019116
  3  FAIL exit 1  exit1:3c9267cd7d019116
REPRODUCED: every attempt failed exactly as the capsule recorded.
```

28 s wall. The machine stays up (`--keep`), so `twin shell` and `twin shell --web` open the failing environment: the browser terminal served its page (HTTP 200, a password required, HTTP 401 without it). `picomatch` was not pinned, because several new copies of it are recorded and there is no single version to install; the failure reproduces without it.

## Bisect finds the cause

**Bisect (245 s wall, 10 trials).** twin built the good environment (22 s), then applied the failing side's package versions on top of it. Candidates: 32. Applying all 32 fails; halving found that `lru-cache@11.3.0` alone fails and the good environment passes:

```text
Minimal failing difference:
  lru-cache@11.3.0
```

The tree holds five copies of `lru-cache`, one per dependent (versions 4, 5, 6, 7 and 11). Only the new 11.3.0 copy differs from the lockfile install, and twin varies that one. No test names this package, so nothing in the failure would lead there without the comparison.

## Verify checks a real fix

`fix.patch` scopes an override to the package that pulls the bad copy, and refreshes the lockfile:

```json
"overrides": { "jsdom": { "lru-cache": "^11.3.2" } }
```

`twin verify bad.json --patch fix.patch` first runs the command once without the fix on its own machine (it fails the captured way), then applies the patch on a fresh machine, installs, and runs the command three times:

```text
  ✓ pin 31 packages to the capsule's versions (...)  5.8s
  1  PASS  34.0s
  2  PASS  33.8s
  3  PASS  34.2s
FIXED: the command passes in the reporter's environment with the fix applied.
```

172 s wall. The pin step leaves out `lru-cache`, because the fix sets it; every other package still matches the capsule. With a documentation-only patch the same run pins all 32 packages and reports `STILL FAILING` (`verify-bogus.txt`, 78 s).

## An agent does the same

Over MCP, `replay` keeps the machine, `run` executes the failing test and `npm ls lru-cache` on it, `verify` checks the patch and `release` stops the machine. `mcp.txt` is a script doing this; `claude-session.txt` is a real `claude --model haiku` session (8 turns, about $0.07) that replayed the capsule, ran the test on the kept machine, verified the patch with `FIXED` and released the machine. The agent's own summary misnamed the `lru-cache` version, so read the tool output, not the summary.

## Honest notes

- **The reporters were not DOMPurify's.** The issue's reporters ran into it with other jsdom-based test setups. DOMPurify is the project replayed here because its lockfile and jsdom tests make the drift reproducible.
- **The fresh install is date pinned.** `npm install --before=<date>` reproduces what npm resolved at that time; it is not a capture from a reporter's real machine.
- **Pinning covers npm projects.** Only packages that are installed but at other versions are pinned; `--no-pin` turns it off, and `--ref` runs do not pin.
- **The fix here is a workaround for the window.** The upstream fix is `lru-cache` 11.3.2; the patch keeps DOMPurify's installs on a safe copy whichever version a fresh install resolves.
- Capture recorded environment variable names only, so `bad.json` lists names such as `CLAUDECODE` from the machine that captured it, with no values.

## Run it yourself

```sh
export SOLARI_API_KEY=...
cd examples/lru-cache-397
twin diff good.json bad.json
twin replay bad.json
twin bisect bad.json --good good.json
twin verify bad.json --patch fix.patch
```

Replay takes about 30 s, bisect about 4 minutes, verify about 3 minutes.
