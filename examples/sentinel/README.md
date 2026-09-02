# Sentinel (TypeScript)

Two primitives at once, from one API key: a cloud browser reads the vendor's published `/security` page while a sandbox checks the same host's HTTPS response headers. They run concurrently and the results are joined, so the whole thing costs about as long as the slower half.

Everything here is passive and public — one GET to a page anyone can open, one GET for response headers. Nothing authenticates and nothing writes.

Three things that bite, each commented at the line where it happens:

- `browser.close()` releases the session, but `solari.close()` is separate and required in Node. Skip it and the script prints its output and then hangs forever.
- `goto` follows redirects, so the host you asked for is not always the host that answered. `status.github.com` lands on `githubstatus.com`. Check `page.url()` before reading anything, or you quote another company's page as this vendor's.
- `commands.run` does not shell-interpret `cmd` — argv goes in `args`. Run `sh` explicitly for redirection, and keep the target an argument rather than pasting it into the script.

## Run

```bash
cd examples/sentinel
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start -- vercel.com
```

One browser session and one sandbox per run, both torn down in `finally`. A run takes a few seconds; check your own balance in the console for what that costs.

This is the pattern behind [Sentinel](https://github.com/TanmayKallakuri/sentinel), which scores a full vendor posture report from it: governance signals across the trust surface, TLS, email authentication, DNS hygiene, and Certificate Transparency.

Source: [`index.ts`](index.ts)
