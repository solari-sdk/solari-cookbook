"""Fixed, dependency-free ProcureLens JSON processor. No external I/O beyond stdio."""
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP, localcontext
import json
import re
import sys
import unicodedata

FIELDS = ('price', 'availability', 'stock', 'leadTimeDays')
KEYS = {'id', 'sku', 'name', 'price', 'currency', 'availability', 'stock', 'leadTimeDays'}
AVAILABILITY = {'in_stock', 'out_of_stock', 'discontinued', 'preorder', 'backorder'}
DRIFT = ('PRICE_DRIFT', 'AVAILABILITY_MISMATCH', 'STOCK_MISMATCH', 'LEAD_TIME_DRIFT')
CHANGED = ('PRICE_CHANGED', 'AVAILABILITY_CHANGED', 'STOCK_CHANGED', 'LEAD_TIME_CHANGED')


def decimal_text(value):
    text = format(value, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def require(condition):
    if not condition:
        raise ValueError('Invalid input')


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def validate_rows(rows, requested):
    require(type(rows) is list and len(rows) <= 100)
    seen = set()
    normalized = []
    for row in rows:
        require(type(row) is dict and set(row) == KEYS)
        for key, limit in (('id', 128), ('sku', 256), ('name', 512)):
            value = row[key]
            require(type(value) is str and 0 < len(value) <= limit and bool(value.strip()))
            require(not any(unicodedata.category(c) in ('Cc', 'Cs') for c in value))
        require(row['id'] not in seen)
        seen.add(row['id'])
        require(row['currency'] is None or row['currency'] in ('USD', 'EUR', 'GBP'))
        require(row['availability'] is None or
                (type(row['availability']) is str and row['availability'] in AVAILABILITY))
        for key, limit in (('stock', 10**9), ('leadTimeDays', 3650)):
            require(row[key] is None or (type(row[key]) is int and 0 <= row[key] <= limit))
        price = row['price']
        require(price is None or (type(price) is str and
                re.fullmatch(r'[0-9]{1,12}(?:\.[0-9]{1,6})?', price) is not None))
        require(not requested or price is not None or row['availability'] is not None)
        item = dict(row, normalizations=[])
        item['sku'] = unicodedata.normalize('NFKC', row['sku']).strip().upper()
        require(bool(item['sku']))
        if item['sku'] != row['sku']:
            item['normalizations'].append('SKU normalized with Unicode NFKC, trim and uppercase; punctuation retained.')
        if price is not None:
            item['price'] = decimal_text(Decimal(price))
            if item['price'] != price:
                item['normalizations'].append('Price canonicalized with exact decimal arithmetic.')
        normalized.append(item)
    return normalized


def card(classification, internal, supplier, field=None, method='none', reason=''):
    return dict(classification=classification, field=field,
                internalIds=[r['id'] for r in internal], supplierIds=[r['id'] for r in supplier],
                internalValue=internal[0][field] if field and internal else None,
                supplierValue=supplier[0][field] if field and supplier else None,
                matchMethod=method, confidence={'exact_sku': 'exact', 'normalized_sku': 'normalized', 'none': 'none'}[method],
                reason=reason)


def process(data):
    require(type(data) is dict and set(data) == {'operation', 'internal', 'supplier'})
    require(data['operation'] in ('reconcile', 'compare'))
    compare = data['operation'] == 'compare'
    internal = validate_rows(data['internal'], not compare)
    supplier = validate_rows(data['supplier'], False)
    groups = defaultdict(lambda: [[], []])
    for side, rows in enumerate((internal, supplier)):
        for row in rows:
            groups[row['sku']][side].append(row)
    raw_skus = [{r['id']: r['sku'] for r in data[side]} for side in ('internal', 'supplier')]
    cards = []
    matched = ambiguous = 0
    # Group keys sort lexically; references and normalized rows retain input order.
    for sku in sorted(groups):
        left, right = groups[sku]
        if len(left) > 1 or len(right) > 1:
            ambiguous += 1
            cards.append(card('AMBIGUOUS_MATCH', left, right,
                              reason='Duplicate normalized SKU in the observed scope; no row was matched.'))
            continue
        if not left or not right:
            cards.append(card('MISSING_INTERNAL_RECORD' if not left else 'MISSING_SUPPLIER_RECORD', left, right,
                              reason='No counterpart in the supplied observation scope; no catalog-wide absence is claimed.'))
            continue
        matched += 1
        a, b = left[0], right[0]
        method = 'exact_sku' if raw_skus[0][a['id']] == raw_skus[1][b['id']] else 'normalized_sku'
        for index, field in enumerate(FIELDS):
            before, after = a[field], b[field]
            if before is None and (not compare or after is None):
                continue
            currency_unknown = field == 'price' and (a['currency'] is None or b['currency'] is None or a['currency'] != b['currency'])
            if before is None or after is None or currency_unknown:
                cards.append(card('UNCOMPARABLE_FIELD', left, right, field, method,
                                  'Requested value is unknown, or price currencies are unknown or disagree; no value is inferred.'))
                continue
            classification = 'MATCH' if before == after else (CHANGED if compare else DRIFT)[index]
            item = card(classification, left, right, field, method,
                        'Supplied field values agree within the observation scope.' if classification == 'MATCH'
                        else 'Supplied field values differ within the observation scope.')
            if field == 'price' and classification != 'MATCH':
                with localcontext() as context:
                    context.prec = 50
                    old, new = Decimal(before), Decimal(after)
                    difference = new - old
                    percent = None if old == 0 else format((difference / old * 100).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP), 'f')
                    item['delta'] = dict(absolute=decimal_text(difference), percent=percent)
            cards.append(item)
    return dict(version=1, cards=cards,
                summary=dict(internalRecords=len(internal), supplierRecords=len(supplier), matchedPairs=matched,
                             discrepancies=sum(c['classification'] != 'MATCH' for c in cards), ambiguousGroups=ambiguous),
                normalized=dict(internal=internal, supplier=supplier))


def main():
    try:
        payload = sys.stdin.buffer.read(262145)
        require(len(payload) <= 262144)
        data = json.loads(payload.decode('utf-8'), object_pairs_hook=object_pairs,
                          parse_constant=lambda value: require(False))
        output = process(data)
    except (ValueError, TypeError, KeyError, RecursionError, OverflowError):
        sys.stderr.write('Invalid processor input.\n')
        return 2
    sys.stdout.write(json.dumps(output, ensure_ascii=True, separators=(',', ':')) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
