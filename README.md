# Solari Cookbook

Short, runnable examples for [Solari](https://getsolari.com) — cloud browsers,
sandboxes, and desktops behind one API key.

Every example in this repo is a complete program you can run in under a minute.
They are deliberately small: one idea each, no framework, no scaffolding to read
past. Copy one into your project and change the parts you care about.

## Examples

### Cloud browser

| Example | Language | What it shows |
| --- | --- | --- |
| [browser-quickstart-ts](examples/browser-quickstart-ts) | TypeScript | Launch a browser, open a page, read it |
| [browser-quickstart-py](examples/browser-quickstart-py) | Python | Launch a browser, open a page, read it |
| [browser-stealth-proxy-ts](examples/browser-stealth-proxy-ts) | TypeScript | Stealth mode + residential proxy egress |
| [browser-profiles-ts](examples/browser-profiles-ts) | TypeScript | Log in once, reuse the session forever |
| [browser-login-handoff-ts](examples/browser-login-handoff-ts) | TypeScript | Hand the live session to a human to sign in, then save it |
| [browser-session-recording-py](examples/browser-session-recording-py) | Python | Record a session, download the replay |
| [browser-page-assertions-py](examples/browser-page-assertions-py) | Python | Reject a wrong page even when navigation and screenshots succeed |
| [browser-workers-cdp-ts](examples/browser-workers-cdp-ts) | TypeScript | Drive a browser from a Cloudflare Worker, over raw CDP |
| [browser-playwright-runner-ts](examples/browser-playwright-runner-ts) | TypeScript | Run your existing Playwright suite on Solari, no local Chromium |
| [eu-consent-evidence-ts](examples/eu-consent-evidence-ts) | TypeScript | Pre-consent tracker evidence via raw CDP |

### Sandbox

| Example | Language | What it shows |
| --- | --- | --- |
| [sandbox-quickstart-ts](examples/sandbox-quickstart-ts) | TypeScript | Run a command, write and read files |
| [sandbox-quickstart-rb](examples/sandbox-quickstart-rb) | Ruby | Same, with no SDK and no gems — stdlib only |
| [sandbox-code-interpreter-py](examples/sandbox-code-interpreter-py) | Python | Stateful Python kernel for agent loops |
| [sandbox-snapshot-fork-py](examples/sandbox-snapshot-fork-py) | Python | Seed a snapshot, fork clones, and verify each restored the exact file digest |
| [sandbox-port-preview-ts](examples/sandbox-port-preview-ts) | TypeScript | Expose a server in the VM on a public URL |
| [sandbox-scan-untrusted-code-ts](examples/sandbox-scan-untrusted-code-ts) | TypeScript | Run untrusted code and capture what it did (audit hook) |

### Multi-product

One key spans all three, so an example can use more than one at once.

| Example | Language | What it shows |
| --- | --- | --- |
| [form-delivery-check-ts](examples/form-delivery-check-ts) | TypeScript | Submit a form in a browser, verify the lead landed in a sandbox |
| [security-posture-review-ts](examples/security-posture-review-ts) | TypeScript | Browser and sandbox running concurrently on one key |

### Desktop

| Example | Language | What it shows |
| --- | --- | --- |
| [desktop-computer-use-py](examples/desktop-computer-use-py) | Python | Screenshot, click, and type on a Linux GUI |
| [desktop-gui-assert-ts](examples/desktop-gui-assert-ts) | TypeScript | Drive a GUI app, then prove the action landed on disk |

## Applications

Bigger programs built on Solari — a CLI or a UI, its own modules, solving a whole
problem rather than showing one call. See [applications/](applications).

## Running an example

Each directory is self-contained.

```bash
git clone https://github.com/solari-sdk/solari-cookbook.git
cd solari-cookbook/examples/browser-quickstart-ts

npm install                          # or: pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # grab one at console.getsolari.com
npm start                            # or: python main.py
```

One `slr_live_` key works across browsers, sandboxes, and desktops, and every
product bills to the same balance.

## Which product do I want?

- **Cloud browser** — you need a *web page*: scraping, testing, filling forms,
  anything Playwright or Puppeteer would do locally. Adds stealth, managed
  proxies, captcha solving, profiles, and session recording.
- **Sandbox** — you need to *run code*: an LLM's Python, an untrusted build, a
  data job. A headless microVM that boots from a snapshot in about a second.
- **Desktop** — you need a *screen*: computer-use agents, GUI apps, anything
  that has to be clicked. A sandbox plus X11 and a live VNC stream.

## Gotchas the examples encode

Things that cost you an afternoon if you meet them cold:

- **TypeScript: `browser.close()` is enough to exit (as of `@solarisdk/browser`
  0.1.3).** The client keeps a loopback proxy open for connection retries; before
  0.1.3 that listener held Node's event loop open, so you had to
  `await solari.close()` or the script printed its output and then hung forever.
  0.1.3 unrefs the listener — `browser.close()` alone now exits. Calling
  `solari.close()` is still fine and releases the client's pool immediately.
- **A profile does not seed the browser on its own.** `launch({ profileId })` puts the
  stored state on `session.storageState` and stops there. Pass it to
  `newContext({ storageState })` or every run starts anonymous while looking logged in.
  `addCookies()` is not a substitute: it restores the cookies and drops localStorage.
  Building your own context also drops the pool's timezone pin, so a profile +
  proxy flow must pass `timezoneId: browser.proxy?.timezoneId` through as well.
- **The TypeScript SDK cannot run on an edge runtime.** It bundles a
  Playwright fork that wants Node and raw TCP sockets, so Workers, Deno
  Deploy and friends are out. Skip it: every session exposes a CDP endpoint,
  and any runtime that can hold an outbound WebSocket can drive the browser
  directly. See [browser-workers-cdp-ts](examples/browser-workers-cdp-ts).
- **`contexts()` is empty unless you asked for a proxy.** The pool only creates
  a context up front when a session requests one, so `browser.contexts()[0]` is
  `undefined` on a plain `launch()` and a non-null assertion on it will throw at
  `newPage()`. Fall back to `newContext()`. A context you make yourself also
  skips the pool's timezone pin, which matters only when a proxy is attached.
- **The Playwright wire protocol is version-gated; CDP is not.** `connectOptions`
  and `chromium.connect()` speak the wire protocol, and the browser server
  rejects clients whose version differs from the one it runs with a 428, matched
  on Playwright's own User-Agent. Our pin moves. Connecting over the session's
  CDP endpoint has no version gate, so a suite that connects that way survives an
  upgrade on either side. See
  [browser-playwright-runner-ts](examples/browser-playwright-runner-ts).
- **Recording is per session, not per account.** Pass `recording: true` when you
  create the session; without it the replay endpoint 404s forever. The upload is
  async after release, so poll for ~30s before giving up.
- **Sandbox commands are not shell-interpreted.** `run("ls -la")` looks for a
  binary named `ls -la`. Put argv in `args`, or run `sh -c` explicitly.
- **`kill()`, not `close()`, ends a VM.** `close()` drops your local control
  channel; the VM keeps running until its idle timeout.
- **`timeoutMs` is a rolling idle window**, not a hard deadline — it resets on
  every use.

## Links

- Docs — [docs.getsolari.com](https://docs.getsolari.com)
- Console — [console.getsolari.com](https://console.getsolari.com)
- Changelog — [changelog.getsolari.com](https://changelog.getsolari.com)
- Questions — [hello@getsolari.com](mailto:hello@getsolari.com)

## Contributing

New examples are welcome. Keep them small, make them run end-to-end against the
real API, and put anything surprising in a comment right where it bites.

MIT licensed.
