# Cross-platform quickstart

Use the root update entrypoint for the host; do not maintain a second undocumented setup path.

## Linux
```bash
./update.sh
```

## macOS
```bash
./update-macos.sh
```

## Windows PowerShell
```powershell
.\update.ps1
```

The scripts require the expected `tocsindata/solari-cookbook` origin and `develop`/`develop/*` branch, fast-forward the current branch, create the local Python virtual environment, install current Python requirements, run dependency-free static-console Node tests when present, run Python tests, and report that live Solari integration cannot run when `SOLARI_API_KEY` is absent.

For the no-hosting analyst console, a Python application runtime is not required in deployment. Publish or serve only `static-console/`; the root Python tooling is a development/test convenience. See `static-no-hosting.md` for static deployment choices.
