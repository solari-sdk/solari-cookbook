import { object, keys, string, timestamp, supplierUrl, parseRows, hash, type Acquisition, type Capture } from './model.ts';

export function extract(value: unknown, mode: 'SIMULATION' | 'SOLARI'): Acquisition {
  const o = object(value);
  keys(o, ['adapter', 'sourceUrl', 'observedAt', 'httpStatus', 'complete', 'fragments', 'visible']);
  if (o.httpStatus !== 200 || o.complete !== true) throw new Error('Incomplete acquisition');
  const live = mode === 'SOLARI';
  if (o.adapter !== (live ? 'adafruit-jsonld-v1' : 'fixture-v1')) throw new Error('Evidence mode mismatch');
  const sourceUrl = string(o.sourceUrl);
  if (live) supplierUrl(sourceUrl);
  else if (sourceUrl !== 'https://supplier.example/catalog') throw new Error('Invalid fixture origin');
  if (!Array.isArray(o.fragments) || !o.fragments.length || o.fragments.length > (live ? 1 : 100) || Buffer.byteLength(JSON.stringify(o.fragments)) > 65536) throw new Error('Invalid fragments');
  const fragments = o.fragments.map(v => string(v, 65536));
  if (!Array.isArray(o.visible) || o.visible.length !== fragments.length) throw new Error('Missing visible evidence');
  const visible = o.visible.map(v => {
    const item = object(v); keys(item, ['sku', 'name', 'price', 'availability']);
    for (const field of ['sku', 'name', 'price', 'availability']) if (typeof item[field] !== 'string' || (item[field] as string).length > 500) throw new Error('Invalid visible text');
    return { sku: string(item.sku, 80), name: string(item.name, 300), price: item.price as string, availability: item.availability as string };
  });
  const raw = fragments.map(fragment => {
    const item = object(JSON.parse(fragment));
    if (!live) return item;
    keys(item, ['@type', 'sku', 'name', 'offers']);
    if (item['@type'] !== 'Product' || !['string', 'number'].includes(typeof item.sku)) throw new Error('Invalid product');
    const offer = object(item.offers); keys(offer, ['price', 'priceCurrency', 'availability']);
    if (offer.priceCurrency !== 'USD') throw new Error('Live adapter requires USD');
    const states: Record<string, string> = { InStock: 'in_stock', OutOfStock: 'out_of_stock', Discontinued: 'discontinued', PreOrder: 'preorder', BackOrder: 'backorder' };
    const state = string(offer.availability).match(/^https?:\/\/schema\.org\/(\w+)$/)?.[1];
    if (!state || !states[state]) throw new Error('Unknown availability');
    return { sku: String(item.sku), name: item.name, price: offer.price, currency: offer.priceCurrency, availability: states[state], stock: null, leadTimeDays: null };
  });
  const rows = parseRows(raw, 'supplier');
  const money = (s: string) => s.replace(/^\$\s*/, '').replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  const words = (s: string) => s.trim().replace(/\s+/g, ' ');
  const states: Record<string, string> = { 'no longer stocked': 'discontinued', 'out of stock': 'out_of_stock', 'in stock': 'in_stock', preorder: 'preorder', backorder: 'backorder' };
  rows.forEach((row, i) => {
    const v = visible[i]!;
    const availability = live ? states[v.availability.toLowerCase().replace(/-/g, '')] : v.availability;
    if (row.sku !== v.sku || words(row.name) !== words(v.name) || money(row.price ?? '') !== money(v.price) || (row.availability ?? '') !== availability || (live && row.sku !== sourceUrl.split('/').at(-1))) throw new Error('Source and visible evidence disagree');
  });
  const capture: Capture = { adapter: live ? 'adafruit-jsonld-v1' : 'fixture-v1', sourceUrl, observedAt: timestamp(o.observedAt), httpStatus: 200, complete: true, fragments, visible };
  return { capture, rows, sha256: hash({ capture, rows }) };
}
