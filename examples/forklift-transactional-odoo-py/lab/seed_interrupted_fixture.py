"""Create the persistent post-receipt/pre-bill crash state through Odoo ORM."""

import json

from odoo import fields


case_id = "FORKLIFT-INTERRUPTED-001"
vendor = env["res.partner"].search([("ref", "=", "SUP-ACME-04")], limit=1)
product = env["product.product"].search([("default_code", "=", "BEARING-6204")], limit=1)
tax = env["account.tax"].search(
    [("name", "=", "Forklift Purchase Tax 7.5%"), ("company_id", "=", env.company.id)],
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
picking.move_ids.write({"quantity": 6})
validation = picking.button_validate()
if isinstance(validation, dict):
    context = validation.get("context") or {}
    wizard = env["stock.backorder.confirmation"].with_context(**context).create(
        {"pick_ids": [(4, picking.id)]}
    )
    wizard.process()

env.cr.commit()
print(
    "FORKLIFT_INTERRUPTED_FIXTURE="
    + json.dumps(
        {
            "case_id": case_id,
            "purchase_order_id": po.id,
            "picking_ids": po.picking_ids.ids,
            "done_picking_ids": po.picking_ids.filtered(lambda p: p.state == "done").ids,
            "bill_ids": po.invoice_ids.ids,
        },
        sort_keys=True,
    )
)
