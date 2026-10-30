# Browser quickstart (TypeScript)

Launch a cloud browser, open a page, read the title, close. The smallest complete Solari program.

Note the `solari.close()` in the `finally` block — the client keeps a loopback proxy open for connection retries. As of `@solarisdk/browser` 0.1.3 that listener is unref'd, so `browser.close()` alone is enough to exit and `solari.close()` is optional (it releases the client's pool immediately). Before 0.1.3 it was required, or your script would print its output and then hang instead of exiting.

## Run

```bash
cd examples/browser-quickstart-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

Source: [`index.ts`](index.ts)
