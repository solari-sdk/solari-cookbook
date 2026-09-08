# Live proof

This directory contains the sanitized evidence bundle from a live Solari
Sandbox run on September 1, 2026.

- Three candidate plans ran in independent `fromSnapshot` microVMs.
- The surgical update was the only eligible branch.
- The winner was replayed in a fourth clean clone and passed again.
- The saved artifact SHA-256 matches the digest recorded in `run.json`.
- The base VM, all four workers, and the persistent checkpoint were deleted.
- A post-run API inventory found zero active sessions and zero snapshots.

Environment and checkpoint identifiers are redacted. No API key, bearer token,
cookie, or reusable credential is included.

From the use-case directory, inspect the interactive evidence report with:

```bash
python -m worldline serve --directory proof/live
```

The command serves viewer assets from `worldline/static/` and leaves this evidence
unchanged. The HTML, JavaScript, and CSS are not duplicated in the proof bundle.
The local `.gitattributes` preserves the CSV bytes on Windows checkouts so their
recorded digests remain reproducible.
