# Sandbox Git clone (TypeScript)

Clone a public Git repository in a Solari sandbox, inspect its status, and run a command from the checkout.

## Run

```bash
cd examples/sandbox-git-clone-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start -- https://github.com/psf/requests "python3 --version"
```

Source: [`index.ts`](index.ts)
