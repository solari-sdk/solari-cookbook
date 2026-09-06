# Security Policy

## Supported versions

PatchProof is at version 0.1.0. Only the current branch receives fixes.

## Threat model

PatchProof is designed to run **reviewer-owned** regression probes against **publicly pinned** Git commits in disposable Solari sandboxes. It is **not** a system for running untrusted contributor code safely — you are responsible for reviewing the commits you choose to test.

**Known risks:**

- **Guest result forgery**: a malicious revision can print the success witness and exit 0. PatchProof uses exit-code + witness checks as a regression regression oracle, not an adversarial attestation system. The probe belongs to the reviewer; treat it as your guard.
- **Network egress**: sandboxes can access the internet. Do not pass private data, credentials, or internal URLs through PatchProof.
- **Supply chain**: setup commands can install arbitrary packages. Review commits and commands before running.
- **Execution environment**: the guest runner executes inside a disposable Linux VM. Never run code through PatchProof that you have not reviewed for abusive behavior (coin mining, data exfiltration, etc).

**Controls in place:**

- Only public `https://github.com/owner/repo` source URLs with full 40-hex commit hashes are accepted.
- File paths are validated; no `..`, symlink escapes, or absolute paths are allowed.
- Payload sizes, output lengths, and process times are bounded.
- HTML reports escape all guest-controlled strings; `Content-Security-Policy: script-src 'none'` is set.
- Terminal escape sequences and unicode bidi overrides are stripped from displayed text.
- `SOLARI_API_KEY` is read only from the environment, never logged, printed, or hardcoded, and is redacted from all error messages.
- Simulation output is labeled `LOCAL SIMULATION` and explicitly disclaimed as non-Solari evidence.

## Reporting a vulnerability

Open a GitHub issue marked `security`. For sensitive reports, email the maintainer directly. Do not include reproduction scripts that could cause harm if run without review.
