import { isPrivacyMode, putMany } from './storage.js';

const API_PREFIX = '/api/v1';
const SERVER_WORKSPACE_PREFIX = '/workspace';
const REQUEST_TIMEOUT_MS = 8000;

function parseJson(value, fallback) {
  if (value == null || value === '') return structuredClone(fallback);
  if (typeof value !== 'string') return structuredClone(value);
  try { return JSON.parse(value); } catch { return structuredClone(fallback); }
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isServerWorkspace(locationLike = globalThis.location) {
  const path = String(locationLike?.pathname || '');
  return path === SERVER_WORKSPACE_PREFIX || path.startsWith(`${SERVER_WORKSPACE_PREFIX}/`);
}

export function normalizeServerEvent(row) {
  const latitude = finiteOrNull(row?.latitude ?? row?.location?.latitude);
  const longitude = finiteOrNull(row?.longitude ?? row?.location?.longitude);
  const precision = row?.geo_precision ?? row?.location?.precision ?? null;
  return {
    id: String(row.id),
    source_id: String(row.source_id),
    source_record_id: String(row.source_record_id ?? ''),
    category: String(row.category ?? 'uncategorized'),
    title: String(row.title ?? row.id),
    summary: row.summary ?? null,
    observed_at: row.observed_at,
    updated_at: row.updated_at ?? null,
    location: latitude !== null && longitude !== null ? { latitude, longitude, precision, crs: 'EPSG:4326' } : null,
    latitude,
    longitude,
    geo_precision: precision,
    severity: row.severity ?? null,
    quality_score: Number.isFinite(Number(row.quality_score)) ? Number(row.quality_score) : 0,
    properties: parseJson(row.properties ?? row.properties_json, {}),
    evidence: parseJson(row.evidence ?? row.evidence_json, []),
    first_seen: row.first_seen ?? null,
    last_seen: row.last_seen ?? null,
    sighting_count: Number.isFinite(Number(row.sighting_count)) ? Number(row.sighting_count) : 1,
  };
}

export function normalizeServerEntity(row) {
  const latitude = finiteOrNull(row?.latitude ?? row?.location?.latitude);
  const longitude = finiteOrNull(row?.longitude ?? row?.location?.longitude);
  const precision = row?.geo_precision ?? row?.location?.precision ?? null;
  return {
    id: String(row.id),
    type: String(row.type ?? 'unknown'),
    label: String(row.label ?? row.id),
    aliases: parseJson(row.aliases ?? row.aliases_json, []),
    first_seen: row.first_seen ?? null,
    last_seen: row.last_seen ?? null,
    location: latitude !== null && longitude !== null ? { latitude, longitude, precision, crs: 'EPSG:4326' } : null,
    latitude,
    longitude,
    geo_precision: precision,
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0,
    properties: parseJson(row.properties ?? row.properties_json, {}),
    evidence: parseJson(row.evidence ?? row.evidence_json, []),
  };
}

export function normalizeServerRelationship(row) {
  return {
    id: String(row.id),
    source_entity_id: String(row.source_entity_id),
    target_entity_id: String(row.target_entity_id),
    type: String(row.type ?? 'related-to'),
    first_seen: row.first_seen ?? null,
    last_seen: row.last_seen ?? null,
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0,
    observed: row.observed === true || row.observed === 1 || row.observed === '1',
    properties: parseJson(row.properties ?? row.properties_json, {}),
    evidence: parseJson(row.evidence ?? row.evidence_json, []),
  };
}

export function normalizeServerEvidence(row, index = 0) {
  const identity = row.id || `${row.event_id || 'event'}:${row.kind || 'evidence'}:${row.field || row.source_path || index}`;
  return { id: `server-evidence:${identity}`, ...structuredClone(row) };
}

export function normalizeServerSourceState(row, descriptors = new Map()) {
  const id = String(row.source_id ?? row.id ?? 'unknown-source');
  const descriptor = descriptors.get(id) || {};
  const lastCompleted = row.last_completed_at ?? row.completed_at ?? null;
  const lastSuccess = row.last_success_at ?? row.last_success ?? (row.last_status === 'success' ? lastCompleted : null) ?? lastCompleted;
  const count = row.events_total ?? row.events_count ?? row.records_accepted ?? row.event_count ?? '';
  return {
    id,
    last_success: lastSuccess,
    url: descriptor.authoritative_url ?? descriptor.url ?? '',
    count,
    server_status: row.last_status ?? row.status ?? null,
    stale: Boolean(row.stale),
    age_seconds: finiteOrNull(row.age_seconds),
  };
}

async function fetchJson(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_PREFIX}${path}`, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json')) throw new Error(`Expected JSON but received ${contentType || 'unknown content type'}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchServerSnapshot() {
  const [events, entities, relationships, evidence, acquisitions, sourceHealth, sources] = await Promise.all([
    fetchJson('/events?limit=1000'),
    fetchJson('/entities?limit=1000'),
    fetchJson('/relationships?limit=1000'),
    fetchJson('/evidence?limit=1000'),
    fetchJson('/acquisitions?limit=1000'),
    fetchJson('/source-health'),
    fetchJson('/sources'),
  ]);
  const descriptors = new Map(sources.map((item) => [String(item.id), item]));
  return {
    events: events.map(normalizeServerEvent),
    entities: entities.map(normalizeServerEntity),
    relationships: relationships.map(normalizeServerRelationship),
    evidence: evidence.map(normalizeServerEvidence),
    acquisitions,
    source_state: sourceHealth.map((row) => normalizeServerSourceState(row, descriptors)),
    sources,
  };
}

export async function persistServerSnapshot(snapshot) {
  const stores = ['events', 'entities', 'relationships', 'evidence', 'acquisitions', 'source_state'];
  for (const store of stores) {
    const records = Array.isArray(snapshot[store]) ? snapshot[store] : [];
    if (records.length) await putMany(store, records);
  }
}

function setRuntimeStatus(message, state = 'local') {
  const status = document.querySelector('#runtime-status');
  if (status) {
    status.textContent = message;
    status.dataset.runtime = state;
  }
}

function refreshWorkspace() {
  document.querySelector('#refresh-events')?.click();
}

function fillServerSources(sources) {
  const select = document.querySelector('#server-source');
  if (!select) return;
  select.replaceChildren();
  for (const source of [...sources].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const option = document.createElement('option');
    option.value = String(source.id);
    option.textContent = `${source.name} (${source.id})`;
    select.appendChild(option);
  }
}

async function syncServer() {
  const button = document.querySelector('#server-sync');
  if (button) button.disabled = true;
  setRuntimeStatus('Server mode detected — synchronizing normalized public-source data…', 'server');
  try {
    const snapshot = await fetchServerSnapshot();
    await persistServerSnapshot(snapshot);
    fillServerSources(snapshot.sources);
    const persistence = isPrivacyMode() ? 'memory-only workspace' : 'local IndexedDB cache';
    setRuntimeStatus(`Server mode active — synchronized ${snapshot.events.length} event(s), ${snapshot.entities.length} entity record(s), and ${snapshot.relationships.length} relationship(s) into the ${persistence}.`, 'server');
    refreshWorkspace();
    return snapshot;
  } catch (error) {
    setRuntimeStatus(`Server mode is configured but synchronization failed: ${error.message}`, 'error');
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

async function collectServerSource() {
  const select = document.querySelector('#server-source');
  const sourceId = String(select?.value || '');
  if (!sourceId || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(sourceId)) throw new Error('Choose a valid registered server source.');
  const button = document.querySelector('#server-collect');
  if (button) button.disabled = true;
  setRuntimeStatus(`Collecting ${sourceId} through the server runtime…`, 'server');
  try {
    await fetchJson(`/collect/${encodeURIComponent(sourceId)}`, { method: 'POST' });
    await syncServer();
  } finally {
    if (button) button.disabled = false;
  }
}

export async function bootServerRuntime() {
  const serverMode = isServerWorkspace();
  const controls = document.querySelector('#server-runtime-controls');
  if (!serverMode) {
    if (controls) controls.hidden = true;
    setRuntimeStatus('Local/static mode — no application server required.', 'local');
    return { mode: 'local' };
  }
  if (controls) controls.hidden = false;
  document.querySelector('#server-sync')?.addEventListener('click', () => syncServer().catch(() => {}));
  document.querySelector('#server-collect')?.addEventListener('click', () => collectServerSource().catch((error) => setRuntimeStatus(`Server collection failed: ${error.message}`, 'error')));
  document.querySelector('#advanced-server-dashboard')?.setAttribute('href', '/server-dashboard');
  await syncServer().catch(() => {});
  return { mode: 'server' };
}

if (typeof document !== 'undefined') bootServerRuntime().catch((error) => setRuntimeStatus(`Runtime initialization failed: ${error.message}`, 'error'));
