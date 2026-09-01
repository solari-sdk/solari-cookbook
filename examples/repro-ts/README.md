# Repro (Milestone 1)

Repro clones a public GitHub repository into an isolated Solari sandbox and runs one user-supplied command inside the clone. It streams the command's output, reports the Git working-tree state, and destroys the sandbox when it finishes.

## Run

```bash
cd examples/repro-ts
npm install
export SOLARI_API_KEY=slr_live_... # https://console.getsolari.com
npm start -- https://github.com/psf/requests "python3 --version"
```

The command is intentionally passed to `sh -lc`, so quote it as one local CLI argument. Repro accepts only public `github.com/<owner>/<repository>` URLs; it does not use GitHub tokens or call the GitHub issue/PR APIs.

## Local checks

```bash
npm run typecheck
npm test
```
