const encoder = new TextEncoder();

export const MAX_BROKER_RESPONSE_BYTES = 12 * 1024 * 1024;

export function normalizeBrokerEndpoint(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  const url = new URL(clean);
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error('Broker endpoint must use HTTPS (HTTP is allowed only for localhost development).');
  if (url.username || url.password) throw new Error('Broker endpoint must not contain embedded credentials.');
  if (url.hash || url.search) throw new Error('Broker endpoint must not contain a fragment or query string.');
  return url.toString();
}

function validateBrokerPayload(data) {
  if (!data || typeof data !== 'object') throw new Error('Broker returned an invalid response object.');
  if (!Number.isInteger(data.status) || data.status < 100 || data.status > 599) throw new Error('Broker response is missing a valid upstream status.');
  if (typeof data.body_text !== 'string') throw new Error('Broker response is missing body_text.');
  if (encoder.encode(data.body_text).byteLength > MAX_BROKER_RESPONSE_BYTES) throw new Error('Broker response exceeds the static-console safety limit.');
  if (data.final_url) {
    const finalUrl = new URL(data.final_url);
    if (finalUrl.protocol !== 'https:') throw new Error('Broker returned a non-HTTPS upstream URL.');
  }
  if (data.status < 200 || data.status >= 300) throw new Error(`Broker upstream returned HTTP ${data.status}.`);
  return data;
}

export async function fetchViaBroker(endpoint, { sourceId, sourceUrl, accept = 'application/json' }) {
  const brokerEndpoint = normalizeBrokerEndpoint(endpoint);
  if (!brokerEndpoint) throw new Error('No broker endpoint is configured.');
  const publicUrl = new URL(sourceUrl);
  if (publicUrl.protocol !== 'https:') throw new Error('Only HTTPS public-source URLs may be brokered.');
  const response = await fetch(brokerEndpoint, {
    method: 'POST',
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ operation: 'public-source-fetch', source_id: sourceId, source_url: publicUrl.toString(), accept }),
  });
  const text = await response.text();
  if (encoder.encode(text).byteLength > MAX_BROKER_RESPONSE_BYTES) throw new Error('Broker envelope exceeds the static-console safety limit.');
  if (!response.ok) throw new Error(`Broker request failed with HTTP ${response.status}.`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Broker returned invalid JSON.'); }
  return validateBrokerPayload(data);
}
