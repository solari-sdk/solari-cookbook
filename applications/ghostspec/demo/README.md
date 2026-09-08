# A real run

`checkout.spec.ts` was not written by hand and not written from memory. ghostspec
opened saucedemo.com on a Solari cloud browser, performed the flow, and wrote the
spec from the locators it watched work — then ran that spec on a *fresh* browser
before this file was committed.

```
  https://www.saucedemo.com
  "log in as standard_user with password secret_sauce, add the Sauce Labs
   Backpack to the cart, open the cart and complete checkout with name
   Nikhil Jatt and zip 110001"

  exploring on a Solari cloud browser…
  15 steps observed
  writing the spec…
  verifying it on a fresh browser…
  1 passed, 0 failed

  verified — this spec passed on a real browser.
```

## Running it

It is an ordinary `@playwright/test` file with no ghostspec import, so it runs
anywhere Playwright does. To run it on a cloud browser instead of a local one,
use [`examples/browser-playwright-runner-ts`](../../../examples/browser-playwright-runner-ts):
copy its `solari.ts` and `solari.global.ts` next to the spec, point `globalSetup`
at the latter, and change the import to `./solari`.

ghostspec emits that same pair into its own output directory at runtime, which is
what makes a plain `npx ghostspec` outside this repo produce something runnable.
The copy that used to live here was deleted so the two cannot drift.

## What is deliberately not here

The screenshots, the HTML report and the recorded rrweb session from this run are
all produced by a real run and are not committed. Binary fixtures go stale
silently and are hard to review. Run the tool to see them.
