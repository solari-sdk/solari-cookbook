# Solari capability and free-budget research

Checked 2026-09-06 using official documentation, cookbook source, and published npm archives. No Solari session was created; no API keys or account secrets were accessed. Published contracts were inspected, not validated against a live account.

## Decision

Use a short-lived **headless sandbox** for a bounded job that needs a clean Linux machine, such as reproducing a small build or running a user-supplied transformation. A browser is also viable for an owned-site smoke test. Do not make desktop access, stealth, proxies, captcha solving, permanent preview hosting, or unrestricted hostile-code containment part of a free-tier promise.

## Cost constraints

Free has $3 monthly credits, a listed one-hour maximum session time, three concurrent browsers, one concurrent sandbox, three profiles, and one-day replay retention. Browser compute is $0.15/hour; stealth, proxies and captcha solving are unavailable. Compute rates are $0.0525/vCPU-hour plus $0.0165/GB-hour. Credits do not roll over; the service states it will not bill beyond the balance. Snapshot storage over 10 GB becomes $0.05/GB-month on October 1, 2026. [Official pricing](https://docs.getsolari.com/pricing)

Derived estimates: explicitly selecting 1 vCPU and 2048 MiB gives approximately $0.0855/hour, or $0.007125 per five-minute run; $3 buys about 35 compute hours. Browser five-minute runs cost approximately $0.0125, giving 240 such runs for $3. These calculations exclude other balance use, startup/cleanup time and unspecified billing rounding. Reserve budget rather than promising those exact run counts.

**Desktop contradiction:** the pricing page shows VM rates, but the actual create contract requires a paid plan and desktop entitlement. Treat desktops as unavailable on Free unless Solari explicitly confirms otherwise. The API clamps idle timeout to the plan maximum; it does not establish an independent wall-clock deadline. [Sandbox create contract](https://docs.getsolari.com/api-reference/sandboxes#post-sandboxes)

## Browser

`@solarisdk/browser` exports `Solari`. `launch()` returns a browser driven with standard Playwright APIs. Close it in `finally`. With low-level `sessions.create()`, explicitly use `releaseAndWait(id)` after disconnecting the CDP client. The default opts out of recording, profiles and paid features. CDP supports other compatible clients; the direct Patchright WebSocket route requires a matching client, currently documented as `patchright-core@1.62.2`. [Sessions](https://docs.getsolari.com/sessions)

Profiles store Playwright cookies and origin localStorage and can import storage state. They preserve login state, not an indefinitely running browser. Anyone possessing the API key can use those logins. [Profiles](https://docs.getsolari.com/profiles)

Recording requires `recording: true` on creation. Replay download is NDJSON, not an ordinary screen-video assumption. It captures input values by default. Retrieve with `getReplayUrl()` or `downloadReplay()`; preserve wanted artifacts before retention expires. [Recording](https://docs.getsolari.com/recording)

The cookbook reports asynchronous upload after release, recommending polling for roughly 30 seconds. It also records a browser-client event-loop fix in version 0.1.3. [Cookbook lifecycle notes](https://github.com/solari-sdk/solari-cookbook#gotchas-the-examples-encode)

## Sandbox and SDK verification

Published `@solarisdk/sandbox` 0.1.3 is ESM, supports Node >=18, exports `SandboxClient`, and depends on `@solarisdk/core ^0.1.3`. `SandboxClientOptions` requires both `apiKey` and `baseUrl`, despite short guide examples omitting the latter. Pin versions and verify typechecking instead of copying every example literally. [Published sandbox archive, package.json and dist/sandbox-client.d.ts](https://registry.npmjs.org/@solarisdk/sandbox/-/sandbox-0.1.3.tgz)

Published core 0.1.3 `CreateSandboxOptions` includes CPU, memory, disk, envs, metadata, timeout, snapshot, lifecycle and volumes. `CommandOptions` includes argv, cwd, env, user, timeout, background and stream callbacks. Commands return `exitCode`, `stdout`, `stderr`; a failed command is not necessarily a thrown exception. `kill()` awaits its remote kill hook and then closes the channel. `previewUrl()` delegates to the client hook. No network allowlist or `allowInternet` field was found in the published declaration files. [Core archive, dist/types.d.ts and dist/handle.js](https://registry.npmjs.org/@solarisdk/core/-/core-0.1.3.tgz)

Call `connect()` before files, code, git, PTY or background commands. Plain `commands.run()` can use HTTP without it. Commands execute a binary plus argv; shell syntax needs an explicit shell. `runCode()` supports stateful contexts and returns runtime failures in `error`. `close()` only drops the local channel; **`kill()` releases remote compute**. [TypeScript sandbox reference](https://docs.getsolari.com/sdk/typescript/sandboxes)

`timeoutMs` is a rolling idle window refreshed by use and open connections. `onTimeout: "pause"` is the default; choose `"kill"` for disposable work. The guide says default idle timeout is 30 minutes, whereas API reference says two hours for sandboxes. Always set it explicitly. [Sandbox guide](https://docs.getsolari.com/sandboxes#idle-timeout)

Recommended application policy: one active run; explicit `cpu: 1`, `memMb: 2048`; a short command timeout; five-minute application wall-clock limit; `finally` cleanup; record the resource ID before execution; retry failed cleanup and reconcile owned unfinished runs. A JavaScript timeout alone does not stop remote execution. Avoid polling resource status as an idle shutdown mechanism: authorized status reads refresh its idle deadline. DELETE closes billing; pause saves RAM/disk and stops compute billing, while resume opens a new billing segment. [Lifecycle contract](https://docs.getsolari.com/api-reference/sandboxes)

## Network, persistence and desktop limits

Solari describes hardware-isolated microVMs and Linux guests. This supports separation from the developer workstation, but is not evidence of an egress firewall or a malware-analysis guarantee. [Platform overview](https://docs.getsolari.com/)

Preview URLs are public, signed capabilities with one-hour tokens (`pt_token` or `x-pinetree-preview-token`). A missing/expired token gives 401; an unready service gives 425. Availability depends on deployment configuration. A preview ends with its underlying compute; it is not permanent application hosting. [Port preview guide](https://docs.getsolari.com/sandboxes#expose-a-port)

The cookbook preview example uses the older `SolariClient` aggregate import from `@solarisdk/sdk`; current split-package documentation uses `SandboxClient`. Follow the inspected package types. [Actual preview example](https://github.com/solari-sdk/solari-cookbook/blob/main/examples/sandbox-port-preview-ts/index.ts)

Desktop supports Linux GUI screenshots, mouse, keyboard, shell, files and a VNC stream. It is useful only when a GUI is essential and paid entitlement is acceptable. [Desktop guide](https://docs.getsolari.com/desktops)

## Defensible narrow products and unresolved questions

1. **Small build reproduction report:** run a bounded, explicitly selected build in a fresh Linux guest; return exit code, logs and artifacts. Isolation and repeatability are the value. Start with controlled fixtures and no credentials.
2. **Disposable data-transform workbench:** run a bounded Python transform and return a file plus execution evidence. Remote Linux dependencies and clean state are the value.
3. **Owned-site browser smoke report:** execute a fixed public-page flow, capture evidence and close the browser. No anti-bot bypass is needed.

These are design recommendations, not claims of live-tested reliability. Unresolved: billing granularity; exact enforcement of the advertised one-hour maximum versus rolling idle; actual free-account entitlements; egress/metadata-service restrictions; preview availability; cleanup behavior under worker crash or unreachable gateway; included template binaries; storage/volume charging beyond published snapshot terms. Verify the selected narrow path with one explicitly budgeted session before promising production support.
