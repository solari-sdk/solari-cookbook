# Repository discovery

The initial workspace contained only installed skill files and `skills-lock.json`; no Git repository or application existed. Cloned the official `solari-sdk/solari-cookbook` and preserved its history. Upstream baseline: `46709a1c374a3d509e8b95f5b5c26095e7c1d7db`. Remote is named `upstream`; no user fork URL or authenticated GitHub CLI was supplied at discovery.

The cookbook has nine self-contained TypeScript/Python examples for browsers, profiles, proxies, recording, sandbox commands, interpreter, preview ports, and desktop actions. TypeScript examples use `tsx` and `typescript`; Python examples have individual requirements files. No root package, tests, scripts, CI, AGENTS.md, CLAUDE.md, issue template, architecture convention, or shared product abstraction existed. Root `.gitignore` ignored lockfiles; the new application will explicitly retain its lockfile. Preserve the examples and upstream license, move the original README into docs when the product README is written.

Node 24.19.0 and npm 11.17.0 are available. Python and gh were not on PATH initially. No SOLARI_API_KEY environment variable was present. Secret values were not printed. SDK source inspection used npm archives for `@solarisdk/sandbox` and `@solarisdk/core` 0.1.3; no remote compute was allocated.

## Skills applied

The project skill lock records provenance for all five requested systems. Superpowers supplied discovery, design, planning, TDD, debugging and review structure. Karpathy supplied explicit acceptance criteria and surgical preservation of cookbook examples. Ponytail removed browsers, LLMs, database, queue, and accounts from the design. Caveman guides short updates, with normal prose in persisted documents. Matt Pocock's research skill drove independent primary-source investigation; its TDD guidance places tests at manifest/verdict, runner/provider, guest protocol, and CLI boundaries rather than private methods. The mission's explicit authorization to choose and continue supersedes skill-level repeated approval prompts.
