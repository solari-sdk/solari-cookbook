# @wsp/collect

Reads a developer machine and produces the manifest `wsp init` shows: identity, shell, toolchains, tools, agents and logins, one row per thing that could be brought to a golden. It also decides the small recipe `wsp recipe` writes: which catalog entries are on this machine, which the agents' session histories show in use, and the catalog's own defaults for the rest.

`data/linux-bottles.ts` is the snapshot of Homebrew formulae with a Linux bottle; refresh it with `pnpm --filter @wsp/collect run bottles`.
