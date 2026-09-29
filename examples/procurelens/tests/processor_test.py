import json
from pathlib import Path
import subprocess
import sys
import unittest

PROCESSOR = Path(__file__).resolve().parents[1] / 'processor.py'


def row(id='i1', sku='A-1', **values):
    return dict(id=id, sku=sku, name='Item', price='129.00', currency='USD',
                availability=None, stock=None, leadTimeDays=None) | values


class ProcessorTest(unittest.TestCase):
    def invoke(self, internal, supplier, operation='reconcile'):
        result = self.raw(json.dumps(dict(operation=operation, internal=internal, supplier=supplier)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        return json.loads(result.stdout)

    def raw(self, data):
        return subprocess.run([sys.executable, str(PROCESSOR)], input=data,
                              text=True, encoding='utf-8', capture_output=True)

    def test_exact_decimal_match_and_provenance(self):
        result = self.invoke([row()], [row('s1', price='129')])
        self.assertEqual(result['version'], 1)
        self.assertEqual(result['summary'], dict(internalRecords=1, supplierRecords=1,
                         matchedPairs=1, discrepancies=0, ambiguousGroups=0))
        card = result['cards'][0]
        self.assertEqual((card['classification'], card['matchMethod'], card['confidence']),
                         ('MATCH', 'exact_sku', 'exact'))
        self.assertEqual((card['internalIds'], card['supplierIds']), (['i1'], ['s1']))
        self.assertEqual(result['normalized']['internal'][0]['price'], '129')
        self.assertTrue(result['normalized']['internal'][0]['normalizations'])

    def test_normalized_identity_preserves_punctuation(self):
        result = self.invoke([row(sku=' ａ-１ ')], [row('s1')])
        self.assertEqual(result['cards'][0]['matchMethod'], 'normalized_sku')
        self.assertEqual(result['normalized']['internal'][0]['sku'], 'A-1')
        result = self.invoke([row()], [row('s1', sku='A1')])
        self.assertEqual({c['classification'] for c in result['cards']},
                         {'MISSING_INTERNAL_RECORD', 'MISSING_SUPPLIER_RECORD'})
        self.assertTrue(all('scope' in c['reason'] for c in result['cards']))

    def test_collision_blocks_exact_match_and_never_reuses_rows(self):
        result = self.invoke([row(), row('i2', sku='a-1')], [row('s1')])
        self.assertEqual(len(result['cards']), 1)
        self.assertEqual(result['cards'][0]['classification'], 'AMBIGUOUS_MATCH')
        self.assertEqual(result['cards'][0]['internalIds'], ['i1', 'i2'])
        self.assertEqual(result['summary']['matchedPairs'], 0)
        self.assertEqual(result['summary']['ambiguousGroups'], 1)

    def test_requested_fields_only_unknown_and_currency(self):
        result = self.invoke([row(stock=2, leadTimeDays=3, availability='in_stock')],
                             [row('s1', price=None, availability='out_of_stock', stock=0, leadTimeDays=4)])
        self.assertEqual([c['classification'] for c in result['cards']],
                         ['UNCOMPARABLE_FIELD', 'AVAILABILITY_MISMATCH', 'STOCK_MISMATCH', 'LEAD_TIME_DRIFT'])
        result = self.invoke([row()], [row('s1', currency='EUR', stock=10)])
        self.assertEqual(len(result['cards']), 1)
        self.assertEqual(result['cards'][0]['classification'], 'UNCOMPARABLE_FIELD')

    def test_compare_exact_money_delta_and_null_transitions(self):
        result = self.invoke([row()], [row('s1', price='139', availability='in_stock')], 'compare')
        self.assertEqual(result['cards'][0]['classification'], 'PRICE_CHANGED')
        self.assertEqual(result['cards'][0]['delta'], {'absolute': '10', 'percent': '7.75'})
        self.assertEqual(result['cards'][1]['classification'], 'UNCOMPARABLE_FIELD')
        result = self.invoke([row(price='0')], [row('s1', price='0.000001')], 'compare')
        self.assertEqual(result['cards'][0]['delta'], {'absolute': '0.000001', 'percent': None})
        result = self.invoke([row(price=None)], [row('s1')], 'compare')
        self.assertEqual(result['cards'][0]['classification'], 'UNCOMPARABLE_FIELD')

    def test_malformed_inputs_fail_safely(self):
        valid = dict(operation='reconcile', internal=[row()], supplier=[row('s1')])
        bad_rows = [row(price=1.2), row(price='1e2'), row(price='-1'), row(price='1.1234567'),
                    row(price='1234567890123'), row(stock=True), row(stock=1000000001),
                    row(leadTimeDays=3651), row(price=None), row(sku=' '), row(sku='x'*257),
                    row(name='x'*513), row(extra='secret'), row(currency='INR'),
                    row(availability='unknown'), row(id='')]
        payloads = [json.dumps(valid | {'internal': [bad]}) for bad in bad_rows]
        payloads += [json.dumps(valid | {'internal': [row(), row()]}),
                     json.dumps(valid | {'supplier': [row(str(i)) for i in range(101)]}),
                     json.dumps(valid | {'extra': True}), '{', '[]', ' '*262145,
                     '{"operation":"compare","operation":"reconcile","internal":[],"supplier":[]}']
        for payload in payloads:
            with self.subTest(payload=payload[:60]):
                result = self.raw(payload)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr.strip(), 'Invalid processor input.')

    def test_supplier_collision_and_deterministic_group_order(self):
        result = self.invoke([row(sku='Z'), row('i2', sku='A')],
                             [row('s1', sku='a'), row('s2', sku='A'), row('s3', sku='Z')])
        self.assertEqual([c['classification'] for c in result['cards']], ['AMBIGUOUS_MATCH', 'MATCH'])
        self.assertEqual(result['cards'][0]['supplierIds'], ['s1', 's2'])
        self.assertEqual(result['summary'], dict(internalRecords=2, supplierRecords=3,
                         matchedPairs=1, discrepancies=1, ambiguousGroups=1))
        self.assertEqual([r['id'] for r in result['normalized']['internal']], ['i1', 'i2'])
        self.assertEqual(result, self.invoke([row(sku='Z'), row('i2', sku='A')],
                         [row('s1', sku='a'), row('s2', sku='A'), row('s3', sku='Z')]))

    def test_compare_all_changes_and_large_exact_decimals(self):
        result = self.invoke([row(price='999999999999.999999', stock=1000000000,
                                 leadTimeDays=3650, availability='preorder')],
                             [row('s1', price='999999999999.999998', stock=0,
                                  leadTimeDays=0, availability='backorder')], 'compare')
        self.assertEqual([c['classification'] for c in result['cards']],
                         ['PRICE_CHANGED', 'AVAILABILITY_CHANGED', 'STOCK_CHANGED', 'LEAD_TIME_CHANGED'])
        self.assertEqual(result['cards'][0]['delta']['absolute'], '-0.000001')
        self.assertEqual(result['summary']['discrepancies'], 4)
        result = self.invoke([row(price='130')], [row('s1', price='129')])
        self.assertEqual(result['cards'][0]['classification'], 'PRICE_DRIFT')
        result = self.invoke([row(price=None, availability='in_stock')],
                             [row('s1', price=None, availability='in_stock')])
        self.assertEqual([c['field'] for c in result['cards']], ['availability'])

    def test_ill_typed_nested_and_unicode_inputs_fail_safely(self):
        valid = dict(operation='reconcile', internal=[row()], supplier=[row('s1')])
        values = [valid | {'operation': {}}, valid | {'supplier': {}},
                  valid | {'internal': [row(currency={})]},
                  valid | {'internal': [row(availability=[])]},
                  valid | {'internal': [row(name='bad\ud800')]},
                  valid | {'internal': [row(stock=-1)]},
                  valid | {'supplier': [row('s1'), row('s1')]}]
        for value in values:
            result = self.raw(json.dumps(value))
            self.assertEqual((result.returncode, result.stdout, result.stderr.strip()),
                             (2, '', 'Invalid processor input.'))


if __name__ == '__main__':
    unittest.main()
