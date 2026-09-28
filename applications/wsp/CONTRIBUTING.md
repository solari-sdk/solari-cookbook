# Contributing

wsp is AGPL-3.0-only. By sending a change you agree it is licensed the same
way. New source files start with `// SPDX-License-Identifier: AGPL-3.0-only`.

File bugs and requests at
[github.com/Zingzy/wsp/issues](https://github.com/Zingzy/wsp/issues). Say
what you ran, what you saw, and the output of `wsp --version`. Never paste
a key.

## Setting up

Node 22 or newer and pnpm.

```sh
cd daemon && cargo build --release && cd ..
node packages/wspx/scripts/daemon-binary.mjs   # this computer's daemon, where the host and the suite read it
pnpm install && pnpm build
pnpm test                    # no key needed, creates nothing
pnpm -r exec tsc --noEmit
```

The daemon is Rust and nothing in a node build makes it. The host spawns it
for this computer's own workspace and every test that needs a running daemon
drives that same binary, so the two lines above come first. The toolchain is
the one `daemon/rust-toolchain.toml` names.

On Linux the daemon wsp ships is one static musl binary, and the placing step
refuses a gnu one, so the build line is the musl road the ci workflow takes:
`musl-tools` and `gperf` installed, `daemon/scripts/libseccomp-archive.sh musl`
run, then `LIBSECCOMP_LIB_PATH=$PWD/target/libseccomp/musl cargo build --release
--target x86_64-unknown-linux-musl -p wsp-daemon-bin` in `daemon/`, and
`--triple x86_64-unknown-linux-musl` on the placing line.

On a small computer run vitest by file:
`pnpm exec vitest run --minWorkers=1 --maxWorkers=1 <files>`. The live
tests, which create real machines, are described in
[docs/canary.md](docs/canary.md).

`@zingzy/wsp` and `@wsp/desktop` bundle their dependencies into one file, so their
`build` uses whatever those last built. Building either on its own starts
with `pnpm --filter <name> build:deps`. `pnpm build` and `pnpm release`
already build everything in dependency order, so they need no such step.

## The rules the code follows

These are the decisions the project has already paid for. A change that
breaks one is sent back, however good the rest is.

**Dependencies point one way.** Clients (the app, the command line, the
desktop shell) import `@wsp/protocol`. The runtime imports the engine, the
engine imports a backend. A client importing the engine, or the protocol
importing anything, is wrong.

**Wire types have one home.** Every message shape lives in `@wsp/protocol`
as a zod schema. A second copy in the daemon, the runtime or the app is a
bug, even when it matches today.

**Text is formatted in one place.** Bytes, durations, costs, memory sizes and
the lines a person reads come from `packages/protocol/src/format.ts`. Shell
text goes through `shellQuote` from the same package. Do not spell either
out again elsewhere; there is a test that finds copies.

**Anything that varies by kind sits behind one interface with one module per
variant.** Machine providers, agents, install roads, sign-in kinds, config
paths, status checks, renderer targets: each has a registry, and adding a
variant touches the registry entry and its module, nothing else. A `switch`
on an agent, tool, provider or road id outside its registry is a bug. So is
a second copy of a predicate, a path rule, a marker parser or a size rule:
write it once and import it.

**Provider details stay in the engine.** Solari assumptions above the engine
are wrong; clients read `capabilities` flags instead of assuming. What the
guests need is in [docs/reach.md](docs/reach.md).

**The daemon's token is the only gate on 0.0.0.0.** It travels in the first
WebSocket frame, never in a URL. No handler is registered before that frame
passes. Nothing in wsp collects, stores or proxies a model provider's
credentials outside the person's own computer and machines. Never print or
commit key material; fake keys in tests look fake (`sk-ant-x`).

**No `curl | sh`** in anything that installs software a person chose. Release
binaries are pinned by sha256.

**Comments state a constraint the code cannot show, in one line.** No
narration of what was changed, no ticket numbers, no `TODO`, `FIXME` or
`HACK`.

**No em-dashes** anywhere: code, comments, docs, commit messages, UI text.

## Tests

Logic gets a test that failed before the change and passes after; say so in
the pull request, or say why not. Components get a render test and an
interaction test at least.

Unit tests never touch the cloud: fake backends, stores and daemons run in
process. `pnpm test` is green with no key set, and `tsc --noEmit` is clean,
before anything merges. App tests run under jsdom through the root
`vitest.workspace.ts`; do not add per-file environment hacks.

Never kill a process by pattern (`pkill -f`, `killall`) in a test, a script
or your own cleanup. Start processes with a recorded pid and kill that pid.

## The app

Layout follows the approved design. State is muted monospace text, never a
chip or a badge. Rows in a list are uniform. Colors come from the `@theme`
block of `apps/web/src/index.css`, never literals in a component. Green means running and nothing else; orange
means spend or a confirmation; everything else is zinc. Terminal bytes flow
from the daemon to the pane without a React re-render per chunk. Check both
themes, and re-run the Chromium test when one covers the surface you
changed.

## Commits and pull requests

One change per commit, however many files it touches. The subject is a
conventional one under 72 characters (`fix(host): ...`,
`feat(web): ...`), then a blank line, then two to five lines on why the
change exists, not what it does. No trailers.

A pull request links the issue it answers, says what it does in two
sentences, and reports any place where it departs from what the issue asked
and why. Deviations that are not reported are sent back even when the code
is right.

Releases are cut as described in [docs/release.md](docs/release.md).
