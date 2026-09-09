# Sandbox: scan untrusted code (TypeScript)

Run untrusted code in a fresh microVM and see what it actually did — every file
open, network connection, and subprocess — using a Python audit hook
(`sys.addaudithook`, built into 3.8+), so there's nothing to install in the VM.

This is the core of a "run it somewhere safe and tell me if it's sketchy"
workflow. The sample script behaves like a credential stealer (reads an SSH key,
phones home); the harness reports exactly that.

Run the harness, never the target directly — the harness installs the audit hook
first, then executes the untrusted code.

## Run

```bash
cd examples/sandbox-scan-untrusted-code-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

Built into a full tool — npm/PyPI package scanning, AI-written verdicts, and a
web UI: [github.com/Vinay152003/saferun](https://github.com/Vinay152003/saferun)
· [live demo](https://saferun-ten.vercel.app)

Source: [`index.ts`](index.ts)
