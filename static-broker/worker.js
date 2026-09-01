const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_UPSTREAM_BYTES = 12 * 1024 * 1024;
const PUBLIC_SOURCE_HOSTS = new Map([
  ['usgs-earthquakes', 'earthquake.usgs.gov'],
]);

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8' } });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const expected = String(env.ALLOWED_ORIGIN || '').trim();
  if (!expected || origin !== expected) return null;
  return origin;
}

async function boundedText(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_UPSTREAM_BYTES) throw new Error('upstream_response_too_large');
  return new TextDecoder().decode(bytes);
}

async function publicSourceFetch(payload) {
  const sourceId = String(payload.source_id || '');
  const allowedHost = PUBLIC_SOURCE_HOSTS.get(sourceId);
  if (!allowedHost) throw new Error('unsupported_public_source');
  const url = new URL(String(payload.source_url || ''));
  if (url.protocol !== 'https:' || url.hostname !== allowedHost || url.username || url.password) throw new Error('public_source_not_allowlisted');
  const response = await fetch(url, { headers: { Accept: String(payload.accept || 'application/json') }, redirect: 'follow' });
  const finalUrl = new URL(response.url || url.toString());
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== allowedHost) throw new Error('public_source_redirect_left_allowlist');
  return {
    status: response.status,
    final_url: finalUrl.toString(),
    content_type: response.headers.get('content-type'),
    body_text: await boundedText(response),
  };
}

function delegatedUrl(path, env) {
  const baseValue = String(env.DELEGATE_BASE_URL || '').trim();
  if (!baseValue) throw new Error('delegate_not_configured');
  const base = new URL(baseValue);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('invalid_delegate_base_url');
  const cleanPath = String(path || '');
  if (!cleanPath.startsWith('/') || cleanPath.startsWith('//') || cleanPath.includes('..')) throw new Error('invalid_delegate_path');
  const target = new URL(cleanPath, base);
  if (target.origin !== base.origin) throw new Error('delegate_origin_mismatch');
  return target;
}

async function delegate(payload, env) {
  const authorization = String(env.DELEGATE_AUTHORIZATION || '').trim();
  if (!authorization) throw new Error('delegate_not_configured');
  const target = delegatedUrl(payload.path, env);
  const response = await fetch(target, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload.body ?? {}),
    redirect: 'manual',
  });
  return {
    status: response.status,
    final_url: target.toString(),
    content_type: response.headers.get('content-type'),
    body_text: await boundedText(response),
  };
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (!origin) return new Response('Forbidden origin', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > MAX_REQUEST_BYTES) return json({ error: 'request_too_large' }, 413, origin);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) return json({ error: 'request_too_large' }, 413, origin);
    let payload;
    try { payload = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400, origin); }
    try {
      if (payload.operation === 'public-source-fetch') return json(await publicSourceFetch(payload), 200, origin);
      if (payload.operation === 'delegate') return json(await delegate(payload, env), 200, origin);
      return json({ error: 'unsupported_operation' }, 400, origin);
    } catch (error) {
      return json({ error: String(error?.message || 'broker_error') }, 502, origin);
    }
  },
};
