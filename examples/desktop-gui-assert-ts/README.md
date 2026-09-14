# Prove a GUI action actually did something (TypeScript)

The hard part of desktop automation is not clicking. It is knowing whether the
click worked.

A screenshot shows you a dialog closing. It cannot tell you the file was
written. "It looked right" is exactly how a green run hides a broken save, and
an agent that only ever looks at pixels inherits that problem.

So this drives a real GUI app and then checks two independent things:

1. **What the app claims.** Mousepad puts a `*` in its window title while there
   are unsaved changes, so `xdotool getwindowname` is the app's own answer.
2. **What is true.** The bytes on disk, read back through the sandbox
   filesystem API.

Both have to agree. The screenshot is filed as evidence afterwards, not used as
the verdict.

```
window 54525959: */root/note.txt - Mousepad
after typing:  */root/note.txt - Mousepad   (the * means unsaved)
after ctrl+s:  /root/note.txt - Mousepad

app claims saved: true
disk agrees:      true (39 bytes)
evidence.png:     71449 bytes
```

The unsaved marker is doing real work: if the typing had gone to the wrong
window the title would still read clean, and the run fails there rather than
saving an empty file and calling it a pass.

Mousepad is the subject on purpose — it has no headless mode, so a screen is
genuinely required here rather than decorative. The same shape works for any
GUI whose effect lands somewhere you can read back: a file, a database row, an
HTTP request.

## Run

```bash
cd examples/desktop-gui-assert-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

Writes `evidence.png`, which is gitignored — it is an artifact of your run, not
of the repo.

Source: [`index.ts`](index.ts)
