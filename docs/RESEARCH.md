# ProcureLens research

Verified 2026-09-09. Research used public documentation, npm artifacts and a public supplier GET; no Solari sessions or account calls.

## SDK pins and lifecycle

Public npm registry `latest` returned **@solarisdk/browser 0.1.3** and **@solarisdk/sandbox 0.1.3**. Pin exact versions and commit the lockfile; sandbox depends on `@solarisdk/core ^0.1.3`, so lock that resolved dependency too. Sources: [browser registry](https://registry.npmjs.org/@solarisdk/browser/latest), [sandbox registry](https://registry.npmjs.org/@solarisdk/sandbox/latest). Published implementation inspected directly: [browser 0.1.3 archive](https://registry.npmjs.org/@solarisdk/browser/-/browser-0.1.3.tgz), [sandbox 0.1.3 archive](https://registry.npmjs.org/@solarisdk/sandbox/-/sandbox-0.1.3.tgz), [core 0.1.3 archive](https://registry.npmjs.org/@solarisdk/core/-/core-0.1.3.tgz).

Browser: `new Solari({apiKey, maxAttempts:1, timeoutMs:30000})`; `launch({retries:0})`; use `browser.contexts()[0].newPage()`, then `page.goto(approvedUrl,{waitUntil:'domcontentloaded',timeout:30000})`. `browser.close()` releases remotely; `solari.close()` stops the local proxy. Nest cleanup so client close runs if browser close fails. `expiresAt` is server expiry; request timeout is per HTTP attempt. Do not persist endpoint URLs. [Browser reference](https://docs.getsolari.com/sdk/typescript/browser)

Published browser source adds an important caveat: `launch()` connection failure calls fire-and-forget `sessions.release()`, whereas normal `browser.close()` awaits `releaseAndWait()`. Its close marks the handle closed before release, so a second close cannot retry a failed release. Preserve the session ID for explicit release cleanup and report unconfirmed release honestly. Set `maxAttempts:1` and `retries:0` to avoid implicit new-browser attempts. [Pinned browser implementation](https://registry.npmjs.org/@solarisdk/browser/-/browser-0.1.3.tgz)

Sandbox: `new SandboxClient({apiKey,baseUrl:'https://api.getsolari.com',callTimeoutMs:30000})`; `create({template:'base',timeoutMs:60000,lifecycle:{onTimeout:'kill'}})`; `connect()` before `files.write(path,string)` / `files.readText(path)`; `commands.run('python3',{args:[workerPath,inputPath]})`; inspect `exitCode`; finally `kill()`. `close()` only disconnects locally. Idle timeout resets with use. [Sandbox reference](https://docs.getsolari.com/sdk/typescript/sandboxes), [lifecycle](https://docs.getsolari.com/sandboxes)

Pinned core code reveals tighter bounds are needed: HTTP defaults are five retries and 300-second per-request timeout. Sandbox create has a stable idempotency key across those retries, but calling `create()` again generates another key. SandboxClient does not expose the core HTTP retry settings; its injected `fetch` can enforce a deadline and prevent repeat outbound create requests. Once connected, `commands.run()` uses `cmd.start`, drops `timeoutMs`, and waits indefinitely for exit; `callTimeoutMs` bounds RPC acknowledgment, not command completion. Use an application deadline plus guest `signal.alarm()` and always kill. `kill()` only closes the local channel after successful remote kill: invoke `close()` in an outer finally. [Pinned core `http.js` and `handle.js`](https://registry.npmjs.org/@solarisdk/core/-/core-0.1.3.tgz)

Upstream local examples corroborate browser double cleanup and sandbox connect/kill: `examples/browser-quickstart-ts/index.ts`, `examples/sandbox-quickstart-ts/index.ts`. [Official cookbook](https://github.com/solari-sdk/solari-cookbook)

Keep `SOLARI_API_KEY` host-side only, outside Git and artifacts; never pass it into the sandbox. Solari states possession permits running sessions and reading profiles. [Quickstart security guidance](https://docs.getsolari.com/quickstart)

## Approved-source candidate

**Adafruit product 385** is a real public supplier page with a directly verified Product JSON-LD script. Raw observations: numeric `sku:385`; `offers.price:'9.9500'`; `priceCurrency:'USD'`; `availability:'http://schema.org/Discontinued'`. Visible page agrees that it is no longer stocked. It offers quantity tiers: 1–9 at 9.95, 10–99 at 8.96, 100+ at 7.96. This provides a useful stock discrepancy without fabricated supplier facts. These observations are research, not the live acceptance run. [Supplier page](https://www.adafruit.com/product/385)

Adapter: read `script[type="application/ld+json"]`, parse JSON as data, select Product (including arrays/@graph), ignore WebSite metadata. Convert numeric SKU to a string; preserve original JSON, final URL, capture timestamp and content hash. A supplier-specific DOM adapter could additionally capture the displayed quantity table, but do not confuse discount tiers with separate products. V1 should explicitly compare the single-unit price; missing pack/unit and lead-time facts remain unknown. No authenticated checkout or cart operations are necessary.

## Reconciliation decisions

- SKU is merchant-specific, not globally unique: scope matching to the supplier, exact SKU first; only attempt normalized matching when uniquely determined; collision means review. [Schema.org SKU](https://schema.org/sku)
- Price currency is a separate field: require a supported explicit code, never infer USD solely from `$`. Compare decimal strings exactly using integer coefficients/scales or Python Decimal; do not silently exchange currencies. [Currency definition](https://schema.org/priceCurrency)
- Quantity interval and unit determine offer applicability; a pack or bulk tier cannot safely equal the single-item price without evidence. Record the comparison basis and require review when incompatible. [Eligible quantity](https://schema.org/eligibleQuantity)
- Lead time means order receipt to dispatch/pickup readiness, not transit or arrival time. Preserve raw text, unit and range; missing stays unknown. [Lead-time definition](https://schema.org/deliveryLeadTime)
- Availability and price are independent observations. Keep Discontinued distinct from temporary OutOfStock; retain raw values. [Offer vocabulary](https://schema.org/Offer)

Deterministic V1 output should include matched/changed/missing/ambiguous rows, source provenance, and run-to-run added/removed/changed findings. Demo discrepancies belong in clearly labeled buyer records; supplier observations must come from the actual browser capture. One browser session followed sequentially by one sandbox is sufficient. Fail extraction clearly rather than silently replacing it with fixtures.
