# twin

Reproduce a bug in the environment where it was reported, find the difference that causes it, and check the fix there.

## Try it without capturing anything

The repo holds capsules and recorded runs for real cases. Replay one (needs a [Solari key](https://console.getsolari.com)):

```sh
pnpm install
export SOLARI_API_KEY=slr_live_...
pnpm dev replay examples/lru-cache-397/bad.json
```

`capture`, `inspect` and `diff` work without a key. The other commands stop at once with a clear message when it is missing.

![npm](https://img.shields.io/npm/v/@crypticsaiyan/twincli)
![Node](https://img.shields.io/badge/node-22%2B-339933)
![License](https://img.shields.io/badge/license-MIT-blue)

Website and docs: [twincli.vercel.app](https://twincli.vercel.app)

## Why

"Works on my machine" is usually not a code bug. The commit is the same. What differs is a runtime version, a dependency the lockfile resolved differently, an environment variable, the time zone. The maintainer gets a pasted list of versions nobody can run, and the issue sits at "cannot reproduce".

twin makes the reporter's environment runnable:

1. The reporter runs the failing command through `twin capture`. twin writes a small scrubbed file, a capsule, to attach to the issue.
2. The maintainer runs `twin replay`. twin rebuilds that environment on a clean [Solari](https://getsolari.com) sandbox and runs the command three times.
3. `twin bisect` finds the smallest set of differences between a failing and a passing capsule that turns the pass into a fail.
4. `twin verify` applies a fix in the reporter's environment, so "fixed" means fixed where the bug happened.

## Install

Node 22 or newer.

```sh
npm install -g @crypticsaiyan/twincli
```

Or prefix any command with `npx @crypticsaiyan/twincli`.

## Quickstart

**Reporter**, in the project where the command fails. No account needed, nothing is uploaded:

```sh
twin capture -- npm test
```

twin runs the command as usual, shows what it recorded, and writes `twin-capsule.json` after you confirm. Attach the file to the issue.

**Maintainer**, with a [Solari key](https://console.getsolari.com):

```sh
export SOLARI_API_KEY=slr_live_...
twin replay twin-capsule.json
twin bisect twin-capsule.json --good mine.json
twin verify twin-capsule.json --patch fix.patch
```

`replay` ends in `REPRODUCED` when every attempt fails the way the capsule recorded. Add `--keep` to leave the machine running, then `twin shell` for a terminal on it or `twin shell --web` for a browser terminal you can share with the reporter.

## Examples

Each example has the capsules, the recorded Solari runs and a write-up in [`examples/`](examples).

| Case | Cause | Replay | Bisect | Verify |
|---|---|---|---|---|
| [`lru-cache` 11.3.0, through DOMPurify](examples/lru-cache-397) | one broken package among 32 that differ from the lockfile | `REPRODUCED` 28 s | `lru-cache@11.3.0` 245 s | `FIXED` |
| [apache/echarts#21538](examples/echarts-21538) | `TZ=America/New_York` | `REPRODUCED` 72 s | 69 s | `FIXED` 71 s |
| [date-fns#2068](https://github.com/crypticsaiyan/twin/tree/main/examples/date-fns-2068) | `TZ=America/New_York` | `REPRODUCED` | found | `FIXED` |
| [dayjs `localizedFormat` test, found in the wild](https://github.com/crypticsaiyan/twin/tree/main/examples/dayjs-localizedformat-tz) | `TZ=America/New_York` | `REPRODUCED` | found | `FIXED` |
| [click `test_custom_parser`, found in the wild](examples/click-test-columns) | `COLUMNS=40` | `REPRODUCED` | found | `FIXED` |

## Commands

| Command | What it does |
|---|---|
| `twin capture -- <cmd>` | Run `<cmd>`, record its environment, write a capsule after review |
| `twin inspect <capsule>` | Summarize a capsule |
| `twin diff <a> <b>` | List every environment difference between two capsules |
| `twin replay <capsule>` | Rebuild the environment on Solari and run the command three times |
| `twin bisect <bad> --good <good>` | Find the smallest failing set of differences |
| `twin verify <capsule> --patch <file>` | Check a fix in the reporter's environment |
| `twin shell [machine] [--web]` | Terminal on a kept machine, or a shareable browser terminal |
| `twin list` | Machines twin has running |
| `twin stop [machine]` | Stop one machine, or all of them |
| `twin mcp` | Serve the commands to coding agents over MCP |

Every command has `--help`. Capsules can be paths or https URLs, such as issue attachments. `replay`, `bisect` and `verify` take `--json`. Full reference: [twincli.vercel.app/reference/cli](https://twincli.vercel.app/reference/cli/).

## Coding agents

`twin mcp` gives an agent the reporter's machine: replay the failure, run commands there, write a file, verify a diff on a fresh machine, release the machine.

```sh
claude mcp add twin -e SOLARI_API_KEY=slr_live_... -- npx -y @crypticsaiyan/twincli mcp
```

The [GitHub Action](action.yml) runs `twin verify` on a pull request that says `Fixes #123` when issue 123 has a capsule attached, and fails the check unless the verdict is `FIXED`:

```yaml
on: pull_request
permissions: { contents: read, issues: read, pull-requests: write }
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: crypticsaiyan/twin@main
        with:
          solari-api-key: ${{ secrets.SOLARI_API_KEY }}
```

## What a capsule records

OS and libc, runtimes, package managers and lockfile hashes, installed package versions, git remote, commit and `git diff HEAD`, time zone and locale, and the exit status with a fingerprint of the failure.

Environment variables are recorded by name only. Values are kept for a short allowlist (`NODE_ENV`, `TZ`, `LANG`, `CI`, and a few more) or for names you pass to `--include-env`. The output tail, diff and arguments pass through secret rules, home paths become `~`, and untracked files are recorded by name only. twin shows a summary and lets you read the full JSON before anything is written. Redaction is pattern based, so read the capsule before posting it publicly. Details: [privacy](https://twincli.vercel.app/reference/privacy/).

## How it uses Solari

- One clean Linux sandbox per run, labelled so `twin list` and `twin stop` can find it.
- Setup and the command stream through `commands.start` with twin's own timeout.
- `pty.create` for `twin shell`, and `previewUrl` in front of a password-protected web terminal for `--web`.
- `sandboxes.connect` to re-attach from any computer, and to give an agent a kept machine.
- Every `kill()` is confirmed with `get()` before it counts, and Ctrl-C releases live machines before exiting.

A replay costs a fraction of a cent. Platform behavior measured while building twin is in [DESIGN.md](https://github.com/crypticsaiyan/twin/blob/main/DESIGN.md).

## Development

```sh
pnpm install
pnpm check                      # typecheck, lint and tests
pnpm dev capture -- npm test    # run from source
pnpm build                      # compile to dist/
pnpm e2e:docker <capsule.json>  # replay in a local Docker container, no key needed
```

Every Solari call goes through a small `Backend` interface, so the unit tests run against an in-memory fake. The website source is in [`site/`](https://github.com/crypticsaiyan/twin/tree/main/site).

## License

MIT
