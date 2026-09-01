# Plugin and analyzer authoring guide

The plugin boundary is deliberately small and public-safe. A plugin is described by `PluginManifest` in `app/plugins.py`; manifests identify an ID, version, kind, capabilities, timeout, output limit, and whether sandbox isolation is required.

## Manifest rules

- IDs are lowercase machine identifiers and are unique within a registry.
- Declare capabilities narrowly so callers can discover compatible plugins without executing them.
- Keep timeout and output limits bounded. The current public demo accepts 1–300 seconds and 1 KiB–10 MiB output limits.
- Untrusted/generated analyzer code must remain `sandbox_required=true` and execute through the Solari Sandbox runner.
- Plugin results must be JSON-compatible and should preserve source/event identifiers needed to reconstruct provenance.

## Analyzer contract

Sandbox analyzers define a function named `analyze(payload)` and return a JSON-compatible value. The runner serializes the input payload, executes the analyzer only inside a disposable Solari sandbox, enforces the declared output ceiling, and returns execution metadata including plugin ID/version, sandbox ID, duration, stdout, stderr, error state, and parsed result.

```python
def analyze(payload):
    return {"count": len(payload.get("events", []))}
```

Do not read secrets from input payloads, embed credentials in plugin code, execute source-provided scripts on the host, or treat plugin output as an observed fact. Derived values must be labeled transformed/inferred as appropriate and retain evidence references.

## Discovery and extension kinds

The manifest model reserves kinds for ingestors, analyzers, visualizers, exporters, and connectors. The current executable sandbox runner is implemented for analyzers; the other kinds remain capability-schema groundwork until dedicated execution contracts are implemented and tested.

## Failure behavior

A plugin failure is a visible execution result, not a reason to silently drop an input record. Callers should retain the plugin/version, timeout/output configuration, error state, and correlation/job identifier when one exists. Resource cleanup remains mandatory even on failure.
