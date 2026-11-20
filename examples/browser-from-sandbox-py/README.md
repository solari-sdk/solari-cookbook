# Browser from a sandbox (Python)

Code running inside a Solari sandbox launches a Solari cloud browser, opens a page and prints its title. Use this shape when the code has to be sandboxed, because an agent wrote it or a user uploaded it, and it also needs a real browser.

Nothing browser-related is installed in the VM image. The host creates the sandbox with your `SOLARI_API_KEY` in its environment, installs the Python browser SDK at runtime with `pip install --target` (which works even where the system Python refuses installs), runs the script and kills the sandbox. The base image's packages aren't documented, so the install happens on every run. Anything running in the sandbox can read the key, so use a separate key you can revoke when the code isn't yours. The script also caps its own browser session at five minutes, and the sandbox's `idle_timeout_ms` is a rolling idle window, not a hard deadline.

## Run

```bash
cd examples/browser-from-sandbox-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
python main.py https://example.com
```

Source: [`main.py`](main.py)
