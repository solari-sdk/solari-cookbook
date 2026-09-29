import { createHash } from 'node:crypto';

export type Row = { id: string; sku: string; name: string; price: string | null; currency: string | null; availability: string | null; stock: number | null; leadTimeDays: number | null };
export type Visible = { sku: string; name: string; price: string; availability: string };
export type Capture = { adapter: 'adafruit-jsonld-v1' | 'fixture-v1'; sourceUrl: string; observedAt: string; httpStatus: number; complete: boolean; fragments: string[]; visible: Visible[] };
export type Acquisition = { capture: Capture; rows: Row[]; sha256: string };
export type ProcessorInput = { operation: 'reconcile' | 'compare'; internal: Row[]; supplier: Row[] };
export type Card = { classification: string; field: string | null; internalIds: string[]; supplierIds: string[]; internalValue: string | number | null; supplierValue: string | number | null; matchMethod: string; confidence: string; reason: string; delta?: { absolute: string; percent: string | null } };
export type Reconciliation = { version: 1; cards: Card[]; summary: { internalRecords: number; supplierRecords: number; matchedPairs: number; discrepancies: number; ambiguousGroups: number }; normalized: { internal: (Row & { normalizations: string[] })[]; supplier: (Row & { normalizations: string[] })[] } };
export type ResourceState = 'not_started' | 'released' | 'uncertain';
export type Run = {
  schema: 1; mode: 'SIMULATION' | 'SOLARI'; status: 'COMPLETE' | 'REVIEW_REQUIRED' | 'FAILED_ACQUISITION' | 'FAILED_PROCESSING' | 'CLEANUP_UNCERTAIN';
  startedAt: string; finishedAt: string; internal: Row[]; acquisition?: Acquisition; result?: Reconciliation;
  resources: { browser: ResourceState; sandbox: ResourceState }; processorSha256: string;
  error?: string; sha256: string;
};
export class ServiceFailure extends Error {
  resource: 'browser' | 'sandbox'; released: boolean;
  constructor(resource: 'browser' | 'sandbox', released: boolean) {
    super(`${resource.toUpperCase()}_FAILED`); this.resource = resource; this.released = released;
  }
}
export type Services = {
  acquire(url: string, signal: AbortSignal): Promise<Capture>;
  process(input: ProcessorInput, signal: AbortSignal): Promise<unknown>;
};

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some(key => !Object.hasOwn(value, key))) throw new Error('Unexpected or missing fields');
}
export function string(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid text field');
  return value;
}
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function bytesHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function timestamp(value: unknown): string {
  const v = string(value, 30);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw new Error('Invalid observation timestamp');
  return v;
}
export function supplierUrl(value: string): string {
  if (!/^https:\/\/www\.adafruit\.com\/product\/[1-9]\d{0,7}$/.test(value)) throw new Error('Supported live URL: https://www.adafruit.com/product/<numeric ID>');
  return value;
}
export function parseRows(value: unknown, side: 'internal' | 'supplier', withIds = false): Row[] {
  if (!Array.isArray(value) || value.length > 100 || (side === 'internal' && value.length === 0) || Buffer.byteLength(JSON.stringify(value)) > 262144) throw new Error('Dataset must have 1–100 internal rows, at most 100 supplier rows, and fit 256 KiB');
  const ids = new Set<string>();
  return value.map((v, i) => {
    const o = object(v); keys(o, [...(withIds ? ['id'] : []), 'sku', 'name', 'price', 'currency', 'availability', 'stock', 'leadTimeDays']);
    const id = withIds ? string(o.id, 100) : `${side}:${i + 1}`;
    if (ids.has(id)) throw new Error('Duplicate row identity'); ids.add(id);
    const sku = string(o.sku, 80), name = string(o.name, 300);
    let price: string | null = null;
    if (o.price !== null) { price = string(o.price, 20); if (!/^\d{1,12}(\.\d{1,6})?$/.test(price)) throw new Error('Price must be a nonnegative decimal string'); }
    const currency = o.currency === null ? null : string(o.currency, 3);
    if (currency !== null && !['USD', 'EUR', 'GBP'].includes(currency)) throw new Error('Unsupported currency');
    if (price !== null && currency === null) throw new Error('Priced rows require currency');
    const availability = o.availability === null ? null : string(o.availability, 20);
    if (availability !== null && !['in_stock', 'out_of_stock', 'discontinued', 'preorder', 'backorder'].includes(availability)) throw new Error('Invalid availability');
    function amount(v: unknown, max: number): number | null {
      if (v === null) return null;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw new Error('Invalid nonnegative quantity');
      return v;
    }
    if (side === 'internal' && price === null && availability === null) throw new Error('Internal rows need price or availability to compare');
    return { id, sku, name, price, currency, availability, stock: amount(o.stock, 1e9), leadTimeDays: amount(o.leadTimeDays, 3650) };
  });
}
