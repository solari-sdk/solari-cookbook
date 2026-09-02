"""Create one fully valid purchase-to-pay fixture through Odoo's own ORM.

This is a development-only oracle integration fixture.  It is never used by
the GUI worker and never belongs in the canonical snapshot.
"""

import json

from odoo import fields


case_id = "FORKLIFT-FIXTURE-VALID-001"
vendor = env["res.partner"].search([("ref", "=", "SUP-ACME-04")], limit=1)
product = env["product.product"].search([("default_code", "=", "BEARING-6204")], limit=1)
tax = env["account.tax"].search(
    [("name", "=", "Forklift Purchase Tax 7.5%"), ("company_id", "=", env.company.id)],
    limit=1,
)
journal = env["account.journal"].search(
    [("code", "=", "FLKB"), ("company_id", "=", env.company.id)],
    limit=1,
)

existing = env["purchase.order"].search([("partner_ref", "=", case_id)])
if existing:
    raise RuntimeError(f"fixture already exists: {existing.ids}")

po = env["purchase.order"].create(
    {
        "partner_id": vendor.id,
        "partner_ref": case_id,
        "currency_id": env.ref("base.USD").id,
        "order_line": [
            (
                0,
                0,
                {
                    "product_id": product.id,
                    "product_qty": 10,
                    "product_uom_id": product.uom_id.id,
                    "price_unit": 12.35,
                    "tax_ids": [(6, 0, tax.ids)],
                    "date_planned": fields.Datetime.now(),
                },
            )
        ],
    }
)
po.button_confirm()

picking = po.picking_ids
if len(picking) != 1:
    raise RuntimeError(f"expected one picking, got {picking.ids}")
picking.move_ids.write({"quantity": 10})
validation = picking.button_validate()
if isinstance(validation, dict):
    raise RuntimeError(f"unexpected receipt wizard for full receipt: {validation}")

po.action_create_invoice()
bill = po.invoice_ids
if len(bill) != 1:
    raise RuntimeError(f"expected one bill, got {bill.ids}")
bill.write({"ref": "ACME-FIXTURE-001", "invoice_date": fields.Date.today()})
bill.action_post()

register = env["account.payment.register"].with_context(
    active_model="account.move",
    active_ids=bill.ids,
).create(
    {
        "journal_id": journal.id,
        "amount": bill.amount_residual,
    }
)
register.action_create_payments()

env.cr.commit()
print(
    "FORKLIFT_VALID_FIXTURE="
    + json.dumps(
        {
            "case_id": case_id,
            "purchase_order_id": po.id,
            "picking_ids": picking.ids,
            "bill_id": bill.id,
            "payment_ids": bill._get_reconciled_payments().ids,
        },
        sort_keys=True,
    )
)
