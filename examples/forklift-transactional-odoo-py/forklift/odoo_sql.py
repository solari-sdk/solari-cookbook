"""Read-only PostgreSQL evidence loader for the frozen Odoo 19 schema."""

from __future__ import annotations

from collections import Counter

from .domain import (
    BillEvidence,
    EvidenceBundle,
    JournalEntryEvidence,
    PaymentEvidence,
    PickingEvidence,
    PurchaseCase,
    PurchaseOrderEvidence,
)


def _unexpected_census_ids(
    censuses: dict[str, tuple[int, ...]],
    loaded: dict[str, tuple[int, ...]],
) -> tuple[str, ...]:
    """Report every base object that did not produce exactly one evidence row."""

    unexpected: list[str] = []
    for kind, census_ids in censuses.items():
        census = set(census_ids)
        rows = Counter(loaded.get(kind, ()))
        for object_id in sorted(census | set(rows)):
            count = rows[object_id]
            if object_id not in census or count != 1:
                unexpected.append(f"{kind}:{object_id}:evidence-rows={count}")
    return tuple(unexpected)


def load_case_evidence(dsn: str, case: PurchaseCase) -> EvidenceBundle:
    """Load only case-scoped facts in a fail-closed read-only transaction."""

    try:
        import psycopg
        from psycopg.rows import dict_row

        with psycopg.connect(dsn, row_factory=dict_row) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION READ ONLY")

                cursor.execute("SHOW server_version")
                server_version = str(cursor.fetchone()["server_version"])

                censuses: dict[str, tuple[int, ...]] = {}
                for kind, query in (
                    ("purchase.order", "SELECT id FROM purchase_order ORDER BY id"),
                    ("stock.picking", "SELECT id FROM stock_picking ORDER BY id"),
                    (
                        "account.move:in_invoice",
                        "SELECT id FROM account_move WHERE move_type = 'in_invoice' ORDER BY id",
                    ),
                    ("account.payment", "SELECT id FROM account_payment ORDER BY id"),
                ):
                    cursor.execute(query)
                    censuses[kind] = tuple(int(row["id"]) for row in cursor.fetchall())

                cursor.execute(
                    """
                    SELECT po.id AS object_id,
                           po.partner_ref AS case_id,
                           po.state,
                           partner.ref AS supplier_ref,
                           currency.name AS currency,
                           product.default_code AS sku,
                           line.product_qty AS ordered_qty,
                           line.price_unit AS unit_price,
                           tax.amount / 100::numeric AS tax_rate
                      FROM purchase_order po
                      JOIN res_partner partner ON partner.id = po.partner_id
                      JOIN res_currency currency ON currency.id = po.currency_id
                      JOIN purchase_order_line line ON line.order_id = po.id
                      JOIN product_product product ON product.id = line.product_id
                      JOIN account_tax_purchase_order_line_rel tax_rel
                        ON tax_rel.purchase_order_line_id = line.id
                      JOIN account_tax tax ON tax.id = tax_rel.account_tax_id
                     WHERE po.partner_ref = %s
                       AND line.display_type IS NULL
                     ORDER BY po.id, line.id, tax.id
                    """,
                    (case.case_id,),
                )
                purchase_orders = tuple(PurchaseOrderEvidence(**row) for row in cursor.fetchall())

                cursor.execute(
                    """
                    SELECT picking.id AS object_id,
                           rel.purchase_order_id,
                           picking.state,
                           product.default_code AS sku,
                           CASE WHEN picking.state = 'done'
                                THEN move.quantity ELSE 0::numeric END AS done_qty,
                           CASE WHEN source.usage = 'supplier' AND destination.usage = 'internal'
                                THEN 'incoming' ELSE source.usage || '->' || destination.usage END AS direction
                      FROM purchase_order po
                      JOIN purchase_order_stock_picking_rel rel
                        ON rel.purchase_order_id = po.id
                      JOIN stock_picking picking ON picking.id = rel.stock_picking_id
                      JOIN stock_move move ON move.picking_id = picking.id
                      JOIN product_product product ON product.id = move.product_id
                      JOIN stock_location source ON source.id = move.location_id
                      JOIN stock_location destination ON destination.id = move.location_dest_id
                     WHERE po.partner_ref = %s
                     ORDER BY picking.id, move.id
                    """,
                    (case.case_id,),
                )
                pickings = tuple(PickingEvidence(**row) for row in cursor.fetchall())

                cursor.execute(
                    """
                    SELECT bill.id AS object_id,
                           rel.purchase_order_id,
                           bill.state,
                           partner.ref AS supplier_ref,
                           currency.name AS currency,
                           bill.ref AS reference,
                           product.default_code AS sku,
                           line.quantity AS billed_qty,
                           bill.amount_untaxed AS untaxed,
                           bill.amount_tax AS tax,
                           bill.amount_total AS total,
                           bill.payment_state,
                           bill.amount_residual AS residual
                      FROM purchase_order po
                      JOIN account_move_purchase_order_rel rel
                        ON rel.purchase_order_id = po.id
                      JOIN account_move bill ON bill.id = rel.account_move_id
                      JOIN res_partner partner ON partner.id = bill.partner_id
                      JOIN res_currency currency ON currency.id = bill.currency_id
                      JOIN account_move_line line ON line.move_id = bill.id
                      JOIN product_product product ON product.id = line.product_id
                     WHERE po.partner_ref = %s
                       AND bill.move_type = 'in_invoice'
                       AND line.display_type = 'product'
                     ORDER BY bill.id, line.id
                    """,
                    (case.case_id,),
                )
                bills = tuple(BillEvidence(**row) for row in cursor.fetchall())

                cursor.execute(
                    """
                    WITH case_bills AS (
                        SELECT bill.id
                          FROM purchase_order po
                          JOIN account_move_purchase_order_rel rel
                            ON rel.purchase_order_id = po.id
                          JOIN account_move bill ON bill.id = rel.account_move_id
                         WHERE po.partner_ref = %s
                           AND bill.move_type = 'in_invoice'
                    ), reconciled_payment AS (
                        SELECT DISTINCT bill_line.move_id AS bill_id,
                               payment_line.payment_id
                          FROM account_move_line bill_line
                          JOIN account_account account ON account.id = bill_line.account_id
                          JOIN account_partial_reconcile partial
                            ON partial.debit_move_id = bill_line.id
                            OR partial.credit_move_id = bill_line.id
                          JOIN account_move_line payment_line
                            ON payment_line.id = CASE
                                WHEN partial.debit_move_id = bill_line.id THEN partial.credit_move_id
                                ELSE partial.debit_move_id END
                         WHERE bill_line.move_id IN (SELECT id FROM case_bills)
                           AND account.account_type = 'liability_payable'
                           AND payment_line.payment_id IS NOT NULL
                    )
                    SELECT payment.id AS object_id,
                           reconciled.bill_id,
                           payment.state,
                           partner.ref AS supplier_ref,
                           currency.name AS currency,
                           COALESCE(
                               journal.name->>'en_US',
                               (SELECT value FROM jsonb_each_text(journal.name) LIMIT 1)
                           ) AS journal,
                           payment.amount,
                           payment.is_reconciled AS reconciled
                      FROM reconciled_payment reconciled
                      JOIN account_payment payment ON payment.id = reconciled.payment_id
                      JOIN res_partner partner ON partner.id = payment.partner_id
                      JOIN res_currency currency ON currency.id = payment.currency_id
                      JOIN account_journal journal ON journal.id = payment.journal_id
                     ORDER BY payment.id
                    """,
                    (case.case_id,),
                )
                payments = tuple(PaymentEvidence(**row) for row in cursor.fetchall())

                cursor.execute(
                    """
                    WITH case_bills AS (
                        SELECT bill.id
                          FROM purchase_order po
                          JOIN account_move_purchase_order_rel rel
                            ON rel.purchase_order_id = po.id
                          JOIN account_move bill ON bill.id = rel.account_move_id
                         WHERE po.partner_ref = %s
                           AND bill.move_type = 'in_invoice'
                    ), case_moves AS (
                        SELECT bill.id AS object_id, bill.id AS source_object_id
                          FROM account_move bill
                         WHERE bill.id IN (SELECT id FROM case_bills)
                        UNION ALL
                        SELECT payment.move_id AS object_id, payment.id AS source_object_id
                          FROM account_payment payment
                         WHERE payment.id IN (
                            SELECT DISTINCT payment_line.payment_id
                              FROM account_move_line bill_line
                              JOIN account_partial_reconcile partial
                                ON partial.debit_move_id = bill_line.id
                                OR partial.credit_move_id = bill_line.id
                              JOIN account_move_line payment_line
                                ON payment_line.id = CASE
                                    WHEN partial.debit_move_id = bill_line.id THEN partial.credit_move_id
                                    ELSE partial.debit_move_id END
                             WHERE bill_line.move_id IN (SELECT id FROM case_bills)
                               AND payment_line.payment_id IS NOT NULL
                         )
                    )
                    SELECT move.id AS object_id,
                           case_move.source_object_id,
                           move.state,
                           COALESCE(sum(line.debit), 0) AS debit,
                           COALESCE(sum(line.credit), 0) AS credit,
                           COALESCE(sum(abs(line.balance)) FILTER (
                               WHERE account.account_type = 'liability_payable'), 0) AS payable_amount,
                           COALESCE(sum(abs(line.balance)) FILTER (
                               WHERE line.tax_line_id IS NOT NULL), 0) AS tax_amount
                      FROM case_moves case_move
                      JOIN account_move move ON move.id = case_move.object_id
                      JOIN account_move_line line ON line.move_id = move.id
                      JOIN account_account account ON account.id = line.account_id
                     GROUP BY move.id, case_move.source_object_id, move.state
                     ORDER BY move.id
                    """,
                    (case.case_id,),
                )
                journal_entries = tuple(JournalEntryEvidence(**row) for row in cursor.fetchall())

                unexpected_object_ids = _unexpected_census_ids(
                    censuses,
                    {
                        "purchase.order": tuple(row.object_id for row in purchase_orders),
                        "stock.picking": tuple(row.object_id for row in pickings),
                        "account.move:in_invoice": tuple(row.object_id for row in bills),
                        "account.payment": tuple(row.object_id for row in payments),
                    },
                )

                return EvidenceBundle(
                    purchase_orders=purchase_orders,
                    pickings=pickings,
                    bills=bills,
                    journal_entries=journal_entries,
                    payments=payments,
                    unexpected_object_ids=unexpected_object_ids,
                    metadata={
                        "schema": "odoo-19",
                        "case_id": case.case_id,
                        "postgres_server_version": server_version,
                    },
                )
    except Exception as exc:
        return EvidenceBundle(
            query_errors=(f"{type(exc).__name__}: {exc}",),
            metadata={"schema": "odoo-19", "case_id": case.case_id},
        )
