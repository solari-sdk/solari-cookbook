# How a browser reaches a workspace

A browser talks to a workspace's in-guest daemon through a per-workspace
preview URL minted from the provider. TLS ends at the provider's edge. The
edge checks its signed token, and the daemon checks its own token on top,
because the daemon binds 0.0.0.0 and that token is what guards the port.
Preview tokens expire after 60 minutes; wsp reuses a minted URL while it is
under about 50 minutes old, then swaps tokens (the hostname never changes).
The edge drops sockets that stay quiet for about 30 seconds, so clients send
an app-level heartbeat every 10. A paused workspace's URL goes dark and the
same URL routes again about a second after wake.

## Running the daemon on your own computer

Running `wsp-daemon` locally (tests, hacking on it) will make macOS and
Windows ask about incoming connections, because 0.0.0.0 accepts from the
network. For local runs bind loopback and point it at a token file of your
own, since the in-guest one lives under /root:

```
printf '%s' dev > /tmp/wsp-daemon-token
wsp-daemon --host 127.0.0.1 --token-path /tmp/wsp-daemon-token
```

The file is read at every connection's auth frame, so the host can rotate it
while the daemon runs. Only in-guest deployments need the 0.0.0.0 default,
since the preview edge dials eth0.

## What `wsp doctor` measures

`wsp doctor` walks the whole loop against one live machine and prints what
it measured. One run, client in India, machine in us-west:

```
step                   time      note
-----------------------------------------------------------------------------
golden image           0ms       reused v1 (snap_dl414bbklze6)
fork workspace         15.4s     machine ZGVza3RvcC1wb29sLWktMGZk…
deploy daemon          5889ms    tar upload + in-guest npm install (node-pty compile) + start on 0.0.0.0:7070
mint previewUrl        1125ms    expires in 60min, host c66506663eaa315a9131-7070.preview.getsolari.com
ws connect + first op  1354ms    TLS + upgrade + authed manifest.get through the preview edge
heartbeats (3 x 10s)   30.4s     socket alive past the ~30s idle sweep
inbox round trip       3277ms    REST touch -> inbox.file over the preview socket (~2s watcher quiet window)
kill + verify zero     947ms     workspace deleted, no machines left on the account
-----------------------------------------------------------------------------
TOTAL                  58.4s
```

The golden image builds once (28s in the same session) and every later fork
reuses it.

## Capability flags

Backends implement `MachineBackend` plus a `capabilities` descriptor:
`{ liveCloneForks, pauseMode, previewUrls, signedUrls }`. Clients read the
flags instead of assuming. A backend without preview URLs loses browser reach
and the UI says so instead of pretending.
