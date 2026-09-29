import test from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../src/acquisition.ts';
import type { Capture } from '../src/model.ts';
const capture: Capture = {
  adapter: 'adafruit-jsonld-v1', sourceUrl: 'https://www.adafruit.com/product/385', observedAt: '2026-09-01T09:00:00.000Z', httpStatus: 200, complete: true,
  fragments: [JSON.stringify({ '@type': 'Product', sku: 385, name: 'DHT22 sensor', offers: { price: '9.9500', priceCurrency: 'USD', availability: 'http://schema.org/Discontinued' } })],
  visible: [{ sku: '385', name: 'DHT22 sensor', price: '$9.95', availability: 'No longer stocked' }],
};
test('supplier values retain raw evidence and require visible corroboration', () => {
  const acquisition = extract(capture, 'SOLARI');
  assert.equal(acquisition.rows[0]?.price, '9.9500');
  assert.equal(acquisition.rows[0]?.availability, 'discontinued');
  assert.equal(acquisition.rows[0]?.stock, null);
  assert.equal(acquisition.capture.fragments[0], capture.fragments[0]);
});
test('partial, unavailable, inconsistent and missing evidence fail acquisition', () => {
  assert.throws(() => extract({ ...capture, fragments: [capture.fragments[0]!.replace('USD', 'EUR')] }, 'SOLARI'));
  for (const value of [{ ...capture, complete: false }, { ...capture, httpStatus: 500 }, { ...capture, visible: [] }, { ...capture, fragments: ['{}'] }, { ...capture, visible: [{ ...capture.visible[0]!, price: '$19.95' }] }, { ...capture, sourceUrl: 'https://www.adafruit.com/product/999' }]) assert.throws(() => extract(value, 'SOLARI'));
  assert.throws(() => extract({ ...capture, adapter: 'fixture-v1' }, 'SOLARI'));
});
