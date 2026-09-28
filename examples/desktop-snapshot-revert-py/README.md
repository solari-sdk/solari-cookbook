# Desktop snapshot and revert (Python)

A sandbox snapshot restores files. A desktop snapshot also restores memory, so
running apps and their unsaved state come back too.

This example types a line into Mousepad without saving it, snapshots the
desktop, then kills Mousepad. The text now exists nowhere: not on disk and not
in any process. `revert()` on the same machine brings back the same Mousepad
process with the same unsaved line.

The editor's text is read through the clipboard (select all, copy), not from
pixels, and the clipboard is cleared before every read, so a stale copy cannot
pass. The same readback runs before the snapshot as a positive control. After
the kill, the script asserts that no Mousepad process is left: that is the
negative case. The desktop is killed and the snapshot deleted in `finally`.

## Run

```bash
cd examples/desktop-snapshot-revert-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
python main.py
```

Expected output (a live run on 2026-09-23; PIDs, IDs and timings vary):

```
before snapshot: mousepad pid 701, buffer matches
snapshot: snap_dln07bhwh0hn
after kill: no mousepad process, unsaved text lost
revert: healthy again after 21 s
after revert: mousepad pid 701 is back, buffer matches
Desktop killed and snapshot deleted.
```

It also saves `screenshot.png` of the reverted desktop. This uses one real
desktop and one snapshot, both deleted at the end; normal usage charges apply.

Snapshots and revert are on the unified `/sandboxes` route, so the desktop
comes from `SandboxClient.create_desktop` in `solari-sandbox`, not
`DesktopClient.create`. After a revert the old control connection is dead, so
`wait_ready()` closes it and redials until `health()` answers.

Source: [`main.py`](main.py). Adapted from the reset step of
[Forkloop](https://github.com/rynitepsd-tech/forkloop), which reverts desktops
between agent test runs.
