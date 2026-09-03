"""Idempotent synthetic master-data seed, executed through ``odoo shell``.

The transaction under test is never created here. Only stable company, vendor,
product, tax, and payment-journal data are prepared before the canonical
snapshot is frozen.
"""

import json
import os


admin_password = os.environ.get("FORKLIFT_ADMIN_PASSWORD", "")
if len(admin_password) < 20:
    raise RuntimeError("FORKLIFT_ADMIN_PASSWORD must contain at least 20 characters")


company = env.company
usd = env.ref("base.USD")
us = env.ref("base.us")
company.write({"name": "Forklift Safety Lab", "country_id": us.id, "currency_id": usd.id})

admin = env.ref("base.user_admin")
admin.write(
    {"login": "admin", "password": admin_password, "name": "Forklift Admin"}
)

Partner = env["res.partner"]
vendor = Partner.search([("ref", "=", "SUP-ACME-04")], limit=1)
vendor_values = {
    "name": "ACME Industrial Bearings (Synthetic)",
    "ref": "SUP-ACME-04",
    "supplier_rank": 1,
    "company_type": "company",
    "country_id": us.id,
}
if vendor:
    vendor.write(vendor_values)
else:
    vendor = Partner.create(vendor_values)

Product = env["product.product"]
product = Product.search([("default_code", "=", "BEARING-6204")], limit=1)
product_values = {
    "name": "6204 Precision Bearing",
    "default_code": "BEARING-6204",
    "purchase_ok": True,
    "sale_ok": False,
    "standard_price": 8.10,
    "list_price": 12.35,
    "purchase_method": "receive",
}
if "is_storable" in Product._fields:
    product_values["is_storable"] = True
elif "type" in Product._fields:
    product_values["type"] = "product"
if product:
    product.write(product_values)
else:
    product = Product.create(product_values)

Tax = env["account.tax"]
taxes = {}
for label, amount in (
    ("Forklift Purchase Tax 0%", 0.0),
    ("Forklift Purchase Tax 5.5%", 5.5),
    ("Forklift Purchase Tax 7.5%", 7.5),
    ("Forklift Purchase Tax 19%", 19.0),
):
    tax = Tax.search(
        [("name", "=", label), ("company_id", "=", company.id)],
        limit=1,
    )
    tax_values = {
        "name": label,
        "type_tax_use": "purchase",
        "amount_type": "percent",
        "amount": amount,
        "company_id": company.id,
    }
    if tax:
        tax.write(tax_values)
    else:
        tax = Tax.create(tax_values)
    taxes[label] = tax
tax = taxes["Forklift Purchase Tax 7.5%"]

Journal = env["account.journal"]
journal = Journal.search([("code", "=", "FLKB"), ("company_id", "=", company.id)], limit=1)
if not journal:
    journal = Journal.create(
        {
            "name": "FORKLIFT-BANK",
            "code": "FLKB",
            "type": "bank",
            "company_id": company.id,
        }
    )

env.cr.commit()
print(
    "FORKLIFT_SEED="
    + json.dumps(
        {
            "company_id": company.id,
            "vendor_id": vendor.id,
            "product_id": product.id,
            "tax_ids": {name: record.id for name, record in taxes.items()},
            "journal_id": journal.id,
        },
        sort_keys=True,
    )
)
