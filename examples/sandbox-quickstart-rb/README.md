# Sandbox quickstart (Ruby)

Run untrusted code in a fresh microVM: execute a command, write a file, read it back.

There is no Ruby SDK yet, so this calls the HTTP API directly — and needs **no gems at all**, only `net/http` and `json` from the standard library. `POST /sandboxes/:id/exec` is a deliberate fast path that skips the control-channel handshake, which is why a complete sandbox program fits in one file with no dependencies.

Commands are not shell-interpreted — argv goes in `args`. For pipes or redirection run a shell explicitly: `exec_in(id, "/bin/sh", "-c", "...")`.

## Run

```bash
cd examples/sandbox-quickstart-rb
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
ruby main.rb
```

Source: [`main.rb`](main.rb)
