import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRows, supplierUrl } from '../src/model.ts';
test('internal JSON requires inspectable decimal money and a comparable field', () => {
  const row = { sku: 'ACME-104', name: 'Widget', price: '129.00', currency: 'USD', availability: 'in_stock', stock: null, leadTimeDays: null };
  assert.equal(parseRows([row], 'internal')[0]?.id, 'internal:1');
  assert.throws(() => parseRows([{ ...row, price: 129 }], 'internal'));
  assert.throws(() => parseRows([{ ...row, price: null, availability: null }], 'internal'));
  assert.throws(() => parseRows([{ ...row, sku: '' }], 'internal'));
});
test('only supported public supplier product pages can be live sources', () => {
  assert.equal(supplierUrl('https://www.adafruit.com/product/385'), 'https://www.adafruit.com/product/385');
  for (const url of ['http://www.adafruit.com/product/385', 'https://www.adafruit.com.evil.test/product/385', 'https://127.0.0.1/', 'https://www.adafruit.com/product/385?token=x', 'https://user:pass@www.adafruit.com/product/385']) assert.throws(() => supplierUrl(url));
});
