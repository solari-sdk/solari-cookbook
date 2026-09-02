# Three-minute judge demo

## The sentence

“The GUI worker is allowed to crash, lie, or double-click; its work is only a
proposal. Forklift promotes the exact frozen state only when a fresh database
auditor proves the purchase, inventory, tax, payable, and payment ledgers all
agree.”

## Show, do not pitch

1. Open the final result matrix in `docs/final-results.md`.
2. Point to the wrong-price case: the worker completed its task, yet Forklift
   found `po-unit_price` in the database and retained nothing.
3. Point to the crash-after-receipt case: the receipt existed, the bill did not,
   so `bill-count` blocked promotion.
4. Point to duplicate payment: Forklift did not merely reject everything; Odoo
   collapsed the duplicate action to one reconciled payment and the valid state
   passed.
5. Run `python -m scripts.verify_final_evidence`. It should print
   `"evidence": "VERIFIED"`, six audited positions, eight preserved attempts,
   and zero false acceptances.
6. Show the matched baseline: trusting the same worker's completion signal
   falsely accepted 3 bad states; Forklift accepted 0.

## The honest closer

“This proves a narrow but valuable thing: inside the snapshotted Odoo boundary,
bad GUI work never became the accepted result in the frozen campaign. It does
not pretend to undo a bank transfer or email after it escapes. The next proof
is external use, not a bigger internal benchmark.”
