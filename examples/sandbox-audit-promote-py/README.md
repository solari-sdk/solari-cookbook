# Audit a snapshot before promoting it

A worker says `done` after debiting a buyer but forgetting to credit the seller.
This example rejects that state. A complete transfer passes, becomes a reusable
template through `promote_snapshot()`, and passes again after a fresh boot.

```text
fresh worker -----------> candidate snapshot -> host SQLite audit
                                                      |
                               reject <--- fail       pass
                                                      |
                                           promote exact snapshot
                                                      |
                                            boot and check bytes
```

```bash
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...
python main.py
```

Requires Python 3.11+ with SQLite deserialization support. Uses one cloud VM at
a time and existing Solari credits. All created VMs, snapshots, and the promoted
template have cleanup registered, including when a check fails. Cleanup errors
are surfaced. The development run took 68 seconds; provisioning time varies.

The worker is a deterministic simulation of an agent making a multi-step
database change; this is a snapshot acceptance example, not an AI benchmark or
a payment system. The database is closed before snapshotting. The live worker
is then deliberately corrupted: only the frozen candidate should reach the
auditor and template. SQLite checks run on the host after reading the database
from a separate restored VM.

For a real database transfer, use a database transaction. This example shows a
boundary around fallible multi-step work where the caller cannot assume one
transaction. It trusts the VM/files service and uses synthetic SQLite inputs;
it does not certify a compromised runtime or roll back external side effects.

The run prints its own source hash so an observed result can be tied to the
code being reviewed. A passing demonstration covers these two constructed
cases only.
