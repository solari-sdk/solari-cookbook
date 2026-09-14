# Drive an interactive CLI (TypeScript)

`commands.run` shells out with pipes, so anything it runs is not talking to a
terminal. Most CLIs notice. They drop colours and progress bars, they change
what they print, and an interactive wizard either hangs waiting on stdin or
silently takes every default. Testing that way exercises a path your users
never take.

`pty.create()` gives you a real terminal inside the sandbox. Same machine, same
command:

```
commands.run  isatty: False
pty.create    isatty: True
```

This example runs `npm init` — a wizard nobody can complete without a TTY —
answers its questions one at a time, and then reads back the `package.json` it
wrote. Output scrolling past is not proof that anything happened; the file is.

## The part worth copying

Writing all the answers at once does not work: the prompts arrive when they
arrive, and `npm init` echoes each reply back, so matching against the whole
transcript re-matches prompts you already answered. The `answer()` helper waits
for each prompt in the output that arrived *since the last reply*, then types.
That is the whole trick, and it is about ten lines.

## Run

```bash
cd examples/sandbox-interactive-cli-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

## Where else this matters

Password prompts, `apt-get` confirmations, database shells, `create-*` project
scaffolders, anything reading `/dev/tty`, and any TUI that needs a window size.
`pty.resize(cols, rows)` is there for the last one.

Source: [`index.ts`](index.ts)
