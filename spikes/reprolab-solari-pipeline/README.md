# ReproLab Solari pipeline spike

This is a deliberately narrow capability test, not the ReproLab product. It
checks one byte-for-byte path:

```text
Solari Browser download -> controller -> Solari Sandbox -> Solari Desktop -> LibreOffice clipboard
```

The browser loads `fixture.html` as a `data:` document so the page itself runs
inside the real remote browser without depending on a public fixture host. The
downloaded bytes become the canonical artifact; the sandbox and desktop never
copy from one another.

## Run

```bash
cd spikes/reprolab-solari-pipeline
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...
python spike.py
```

Run artifacts are written under `artifacts/` and ignored by Git. The script
stops at the first failed gate and still attempts to release every remote
resource it created.
