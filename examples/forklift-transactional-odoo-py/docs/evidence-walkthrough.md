# Three-minute evidence walkthrough

## Summary

The GUI worker may crash, report success too early, or submit an action twice.
Its work is only a proposal. Forklift promotes the exact frozen state only when
a fresh database auditor proves that the purchase, inventory, tax, payable, and
payment ledgers agree.

## Walk through the evidence

1. Open the final result matrix in `docs/final-results.md`.
2. Inspect the wrong-price case: the worker completed its task, yet Forklift
   found `po-unit_price` in the database and retained nothing.
3. Inspect the crash-after-receipt case: the receipt existed, the bill did not,
   so `bill-count` blocked promotion.
4. Inspect duplicate payment: Forklift did not merely reject everything; Odoo
   collapsed the duplicate action to one reconciled payment and the valid state
   passed.
5. Run `python -m scripts.verify_final_evidence`. It should print
   `"evidence": "VERIFIED"`, six audited positions, eight preserved attempts,
   and zero false acceptances.
6. Compare the matched baseline: trusting the same worker's completion signal
   falsely accepted 3 bad states; Forklift accepted 0.

## Interpretation

The result supports a narrow claim: inside the snapshotted Odoo boundary, no
invalid GUI result became the accepted state in the frozen campaign. It does
not show that Forklift can undo a bank transfer, email, or other effect after it
leaves the VM, and it is not independent replication.
