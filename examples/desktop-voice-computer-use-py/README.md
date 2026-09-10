# Voice-Directed Desktop Computer-Use (Python)

Drive a real Linux GUI desktop through spoken directives. Voice instructions are interpreted and dispatched as native mouse, keyboard, and windowing actions over Solari's WebSocket control channel.

`streamUrl` can be embedded in any VNC viewer to watch the voice-driven agent execute live.

## Run

```bash
cd examples/desktop-voice-computer-use-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
python main.py
```

Source: [`main.py`](main.py)
