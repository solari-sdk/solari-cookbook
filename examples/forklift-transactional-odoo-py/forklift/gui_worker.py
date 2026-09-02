"""Visible Playwright worker for one Odoo purchase-to-pay case.

This file is uploaded into a disposable Solari desktop. It is deliberately
untrusted: its milestone log can describe actions, but only the post-snapshot
read-only oracle can accept the resulting business state.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


EVENT_PREFIX = "FORKLIFT_EVENT="
COMPLETE_MARKER = "FORKLIFT_WORKER_COMPLETE=1"


def _url(base_url: str, path: str) -> str:
    parts = urlsplit(base_url)
    joined = parts.path.rstrip("/") + path
    return urlunsplit((parts.scheme, parts.netloc, joined, parts.query, parts.fragment))


def _tax_label(rate: str) -> str:
    labels = {
        "0": "Forklift Purchase Tax 0%",
        "0.0": "Forklift Purchase Tax 0%",
        "0.055": "Forklift Purchase Tax 5.5%",
        "0.075": "Forklift Purchase Tax 7.5%",
        "0.19": "Forklift Purchase Tax 19%",
    }
    try:
        return labels[rate]
    except KeyError as exc:
        raise ValueError(f"unsupported frozen tax rate: {rate}") from exc


def _emit(sequence: int, milestone: str, gate_prefix: str | None = None) -> None:
    print(
        EVENT_PREFIX
        + json.dumps(
            {"milestone": milestone, "sequence": sequence},
            sort_keys=True,
            separators=(",", ":"),
        ),
        flush=True,
    )
    if gate_prefix:
        permit = Path(f"{gate_prefix}-{sequence}")
        deadline = time.monotonic() + 120
        while not permit.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        if not permit.exists():
            raise RuntimeError(f"host did not release milestone {sequence}")


def _select_autocomplete(page, input_locator, search: str, exact_text: str) -> None:
    input_locator.fill(search)
    page.locator(".o-autocomplete--dropdown-item").filter(has_text=exact_text).first.click()


def _wait_for_release(path: str = "/tmp/forklift-worker-release") -> None:
    release = Path(path)
    deadline = time.monotonic() + 90
    while not release.exists() and time.monotonic() < deadline:
        time.sleep(0.1)
    if not release.exists():
        raise RuntimeError("host did not release completed worker")


def run(config: dict[str, object]) -> None:
    case = config["case"]
    assert isinstance(case, dict)
    gate_prefix = str(config.get("step_gate_prefix") or "") or None
    field_overrides = config.get("field_overrides") or {}
    duplicate_actions = set(config.get("duplicate_actions") or [])
    assert isinstance(field_overrides, dict)
    headers: dict[str, str] = {}
    token = config.get("preview_token")
    if token:
        headers["Authorization"] = "Bearer " + str(token)

    sequence = 0
    _emit(sequence, "before_login", gate_prefix)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=str(config["browser_path"]),
            headless=False,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--user-agent=ForkliftFaultTarget/1.0",
            ],
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 800},
            ignore_https_errors=True,
            extra_http_headers=headers,
        )
        page = context.new_page()

        page.goto(_url(str(config["preview_url"]), "/web/login"), wait_until="domcontentloaded", timeout=60_000)
        page.locator('input[name="login"]').fill("admin")
        page.locator('input[name="password"]').fill("admin")
        page.locator('button[type="submit"]').click()
        page.locator(".o_web_client").wait_for(state="visible", timeout=60_000)

        page.goto(_url(str(config["preview_url"]), "/odoo/purchase"), wait_until="domcontentloaded", timeout=60_000)
        page.locator(".o_control_panel").wait_for(state="visible", timeout=60_000)
        page.get_by_role("button", name="New", exact=True).click()
        page.locator(".o_form_view").wait_for(state="visible", timeout=60_000)

        _select_autocomplete(
            page,
            page.locator('.o_field_widget[name="partner_id"] input'),
            str(case["supplier_ref"]),
            "ACME Industrial Bearings (Synthetic)",
        )
        page.locator('.o_field_widget[name="partner_ref"] input').fill(str(case["case_id"]))
        page.locator(".o_field_x2many_list_row_add a").first.click()
        product_input = page.locator('.o_field_widget[name="product_id"] input').last
        product_input.wait_for(state="visible", timeout=30_000)
        _select_autocomplete(
            page,
            product_input,
            str(case["sku"]),
            "6204 Precision Bearing",
        )
        page.wait_for_timeout(1_500)
        if str(case["sku"]) not in product_input.input_value():
            raise RuntimeError("product selection did not settle")

        page.locator('.o_data_row .o_field_widget[name="product_qty"] input').fill(
            str(case["ordered_qty"])
        )
        page.locator('.o_data_row .o_field_widget[name="price_unit"] input').fill(
            str(field_overrides.get("unit_price", case["unit_price"]))
        )
        tax_widget = page.locator('.o_data_row .o_field_widget[name="tax_ids"]')
        tax_widget.click()
        for delete_button in tax_widget.locator(".o_delete").all():
            delete_button.click()
        _select_autocomplete(
            page,
            tax_widget.locator("input"),
            _tax_label(str(case["tax_rate"])),
            _tax_label(str(case["tax_rate"])),
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(1_000)

        sequence += 1
        _emit(sequence, "po_draft_saved", gate_prefix)
        page.get_by_role("button", name="Confirm Order", exact=True).click()
        receive_button = page.get_by_role("button", name="Receive", exact=True)
        try:
            receive_button.wait_for(state="visible", timeout=20_000)
        except PlaywrightTimeoutError:
            # Odoo occasionally acknowledges the click before the form's
            # state-transition response reaches the renderer. Reload the same
            # record and retry only if the idempotent confirm action remains.
            page.reload(wait_until="domcontentloaded", timeout=60_000)
            page.locator(".o_form_view").wait_for(state="visible", timeout=60_000)
            confirm_button = page.get_by_role("button", name="Confirm Order", exact=True)
            if confirm_button.count() and confirm_button.is_visible():
                confirm_button.click()
            receive_button.wait_for(state="visible", timeout=40_000)
        po_number = page.locator('.o_field_widget[name="name"]').inner_text().strip()
        if not po_number.startswith("P"):
            raise RuntimeError("confirmed purchase order number was not visible")

        sequence += 1
        _emit(sequence, "po_confirmed", gate_prefix)

        received = str(field_overrides.get("received_qty", case["received_qty"]))
        if received in {"0", "0.0", "0.00"}:
            print(COMPLETE_MARKER, flush=True)
            _wait_for_release()
            browser.close()
            return

        page.get_by_role("button", name="Receive", exact=True).click()
        page.get_by_role("button", name="Validate", exact=True).wait_for(
            state="visible", timeout=60_000
        )
        quantity_cell = page.locator('.o_data_row [name="quantity"]').first
        if not quantity_cell.count():
            raise RuntimeError("receipt quantity cell was not found")
        quantity_cell.click()
        quantity_editor = quantity_cell.locator("input")
        if not quantity_editor.count():
            quantity_editor = page.locator('.o_data_row td[name="quantity"] input').first
        quantity_editor.wait_for(state="visible", timeout=10_000)
        quantity_editor.fill(received)
        page.keyboard.press("Tab")
        page.wait_for_timeout(500)
        if received not in quantity_cell.inner_text():
            raise RuntimeError("receipt quantity edit did not settle")
        sequence += 1
        _emit(sequence, "receipt_quantity_entered", gate_prefix)

        validate_button = page.get_by_role("button", name="Validate", exact=True)
        if "validate_receipt" in duplicate_actions:
            validate_button.evaluate("element => { element.click(); element.click(); }")
        else:
            validate_button.click()
        page.wait_for_timeout(1_500)
        dialog = page.locator(".modal:visible")
        if dialog.count():
            backorder = dialog.get_by_role("button", name="Create Backorder", exact=True)
            apply_button = dialog.get_by_role("button", name="Apply", exact=True)
            if backorder.count():
                backorder.click()
            elif apply_button.count():
                apply_button.click()
            else:
                raise RuntimeError("unexpected receipt validation dialog")
        page.wait_for_timeout(2_000)
        if "Done" not in page.locator(".o_form_view").inner_text():
            raise RuntimeError("receipt did not reach done state")

        sequence += 1
        _emit(sequence, "receipt_validated", gate_prefix)
        page.get_by_text(f"{po_number} ({case['case_id']})", exact=True).first.click()
        page.locator('.o_form_view .o_field_widget[name="order_line"]').wait_for(
            state="visible", timeout=60_000
        )

        page.get_by_role("button", name="Orders", exact=True).click()
        page.get_by_text("Purchase Orders", exact=True).last.click()
        page.locator(".o_list_view").wait_for(state="visible", timeout=60_000)
        order_row = page.locator(".o_data_row").filter(has_text=po_number).first
        order_row.wait_for(state="visible", timeout=30_000)
        order_row.locator('input[type="checkbox"]').click()
        page.get_by_role("button", name="Create Bills", exact=True).click()
        page.locator('.o_form_view .o_field_widget[name="invoice_line_ids"]').wait_for(
            state="visible", timeout=60_000
        )

        sequence += 1
        _emit(sequence, "bill_draft_created", gate_prefix)
        page.locator('.o_field_widget[name="ref"] input').fill(str(case["bill_reference"]))
        page.locator('.o_field_widget[name="invoice_date"] input').fill(date.today().strftime("%m/%d/%Y"))
        page.get_by_role("button", name="Confirm", exact=True).click()
        page.get_by_role("button", name="Pay", exact=True).wait_for(state="visible", timeout=60_000)

        sequence += 1
        _emit(sequence, "bill_posted", gate_prefix)
        if not bool(case["pay_when_billable"]):
            print(COMPLETE_MARKER, flush=True)
            _wait_for_release()
            browser.close()
            return

        page.get_by_role("button", name="Pay", exact=True).click()
        payment_dialog = page.locator(".modal:visible")
        payment_dialog.wait_for(state="visible", timeout=60_000)
        journal_input = payment_dialog.locator('.o_field_widget[name="journal_id"] input')
        _select_autocomplete(
            page,
            journal_input,
            str(case["payment_journal"]),
            str(case["payment_journal"]),
        )

        sequence += 1
        _emit(sequence, "payment_dialog_ready", gate_prefix)
        create_payment = payment_dialog.get_by_role("button", name="Create Payment", exact=True)
        if "submit_payment" in duplicate_actions:
            create_payment.evaluate("element => { element.click(); element.click(); }")
        else:
            create_payment.click()
        payment_dialog.wait_for(state="hidden", timeout=60_000)
        page.wait_for_timeout(2_000)
        if "Paid" not in page.locator(".o_form_view").inner_text():
            raise RuntimeError("bill did not display paid state")

        sequence += 1
        _emit(sequence, "payment_submitted", gate_prefix)
        print(COMPLETE_MARKER, flush=True)
        _wait_for_release()
        browser.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("config")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    run(config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
