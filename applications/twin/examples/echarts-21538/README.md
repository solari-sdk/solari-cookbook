# apache/echarts#21538: a test that only fails in daylight-saving time zones

[apache/echarts#21538](https://github.com/apache/echarts/issues/21538) (open when this was recorded) reports that `roundTime_locale` in `test/ut/spec/util/time.test.ts` fails in any time zone with daylight saving time. A maintainer in a zone without DST runs the same test and it passes.

This folder is that situation captured with twin, then reproduced and explained on Solari sandboxes.

| File | What it is |
|---|---|
| `new-york.json` | capsule from a reporter in `America/New_York`: the test fails |
| `kolkata.json` | capsule from a maintainer in `Asia/Kolkata`: the test passes |
| `replay.txt` | `twin replay new-york.json` on Solari, recorded 2026-09-28 |
| `bisect.txt` | `twin bisect new-york.json --good kolkata.json` on Solari, recorded 2026-09-28 |
| `fix.patch` | a candidate fix for the test helper |
| `verify.txt` | `twin verify new-york.json --patch fix.patch` on Solari, recorded 2026-09-28 |
| `mcp.txt` | a scripted MCP client driving `twin mcp` like a coding agent (`test/e2e/mcp-session.ts`), recorded 2026-09-28 |

Both capsules are from echarts commit `984bf46` (master on 2026-09-12), Node 22.23.3, npm 10.9.9, captured with a minimal environment (`env -i` keeping only `PATH`, `HOME`, `LANG` and `TZ`).

## What happened

**Capture.** On one machine, the same command run under two time zones:

```sh
npx jest --config test/ut/jest.config.cjs --coverage=false test/ut/spec/util/time.test.ts
```

`TZ=America/New_York` fails with exactly the numbers from the issue (`Expected: 528526800000`, `Received: 528523200000`); `TZ=Asia/Kolkata` passes. `twin inspect kolkata.json new-york.json` shows the capsules differ only in the time zone.

**Replay (72 s).** twin rebuilt the reporter's environment on a fresh Solari sandbox: Node 22.23.3 from nodejs.org, the exact commit fetched by SHA, npm 10.9.9, `npm ci` from the lockfile, and `TZ=America/New_York`. Both attempts failed with the same failure signature as the capsule: `REPRODUCED`.

**Bisect (69 s).** twin built the passing (Kolkata) environment once, confirmed it passes on the sandbox, applied the failing environment's differences, and reported the minimal one: `TZ=America/New_York`.

**Verify (71 s).** The test builds its expected dates with a fixed UTC offset taken from January 1970, which is wrong for October in any zone with daylight saving time. `fix.patch` drops the offset: an ISO date-time string without one is parsed as local time, which is what `roundTime(..., false)` works in. It passes locally under seven zones (New York, Berlin, Sydney, Kolkata, UTC, Chatham, São Paulo). `twin verify` then rebuilt the New York reporter's environment on a fresh sandbox, applied the patch on top of the captured commit and ran the test: both attempts passed, `FIXED`. Nothing had to be pushed first.

Timing detail from the runs: `npm ci` dominates setup (about 46 s); the first Jest run on a fresh machine takes 8 s and later runs about 1.7 s. That first run prints a slow-file timing that later runs do not; twin ignores such timing annotations when fingerprinting failures, which is why both attempts match.

**Agent session over MCP (162 s).** `test/e2e/mcp-session.ts` drives `twin mcp` over stdio the way a coding agent would: `replay` reproduced the failure in 71 s and kept the machine; `run` showed `TZ=America/New_York`, Node v22.23.3 and the failing `roundTime_locale` with the issue's numbers; `write_file` and `git apply` put the fix in place and all 15 tests passed; `verify` confirmed `FIXED` on a fresh machine in 74 s; `release` stopped the kept machine (kill confirmed in 7 s).

## Run it yourself

With a Solari key:

```sh
export SOLARI_API_KEY=...
twin replay examples/echarts-21538/new-york.json
twin bisect examples/echarts-21538/new-york.json --good examples/echarts-21538/kolkata.json
twin verify examples/echarts-21538/new-york.json --patch examples/echarts-21538/fix.patch
```

Without a key, against a local Docker container (development harness, same guest scripts):

```sh
pnpm e2e:docker examples/echarts-21538/new-york.json
pnpm e2e:docker:bisect examples/echarts-21538/new-york.json examples/echarts-21538/kolkata.json
```

The capsules name the machine they were captured on (Linux, the probed tool versions) and record environment variable names only; nothing else about that machine is in them.
