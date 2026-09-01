const DB_NAME = 'solari-static-osint';
const DB_VERSION = 1;
const STORE_EVENTS = 'events';
const STORE_META = 'meta';
let solariKey = '';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_EVENTS)) db.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function tx(storeName, mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try { result = action(store); } catch (error) { reject(error); return; }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
  });
}

function stableId(sourceId, recordId) {
  return `${sourceId}:${recordId}`;
}

function normalizeUsgs(payload, sourceUrl) {
  return (payload.features || []).map((feature) => {
    const p = feature.properties || {};
    const coords = (feature.geometry && feature.geometry.coordinates) || [];
    return {
      id: stableId('usgs-earthquakes', feature.id || `${p.time}:${coords.join(',')}`),
      source_id: 'usgs-earthquakes',
      source_record_id: String(feature.id || ''),
      category: 'earthquake',
      title: p.mag == null ? (p.place || 'Earthquake') : `M${p.mag} — ${p.place || 'Earthquake'}`,
      summary: p.type || null,
      observed_at: p.time ? new Date(p.time).toISOString() : new Date(0).toISOString(),
      updated_at: p.updated ? new Date(p.updated).toISOString() : null,
      latitude: coords.length >= 2 ? Number(coords[1]) : null,
      longitude: coords.length >= 2 ? Number(coords[0]) : null,
      severity: p.mag >= 7 ? 'extreme' : p.mag >= 6 ? 'severe' : p.mag >= 5 ? 'high' : p.mag >= 4 ? 'moderate' : 'low',
      quality_score: 1,
      properties: { magnitude: p.mag ?? null, depth_km: coords[2] ?? null, tsunami: Boolean(p.tsunami), detail_url: p.url || null },
      evidence: [{ kind: 'observed', source_url: sourceUrl, source_path: `features[id=${feature.id || ''}]` }],
    };
  });
}

async function saveEvents(events) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_EVENTS, 'readwrite');
    const store = transaction.objectStore(STORE_EVENTS);
    for (const event of events) store.put(event);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getEvents() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_EVENTS, 'readonly').objectStore(STORE_EVENTS).getAll();
    request.onsuccess = () => resolve(request.result.sort((a,b) => String(b.observed_at).localeCompare(String(a.observed_at))));
    request.onerror = () => reject(request.error);
  });
}

async function clearEvents() {
  await tx(STORE_EVENTS, 'readwrite', (store) => store.clear());
}

async function render() {
  const events = await getEvents();
  const body = document.querySelector('#events');
  body.replaceChildren();
  for (const event of events.slice(0, 500)) {
    const row = document.createElement('tr');
    for (const value of [event.observed_at, event.category, event.title, event.source_id]) {
      const cell = document.createElement('td'); cell.textContent = value ?? ''; row.appendChild(cell);
    }
    body.appendChild(row);
  }
  document.querySelector('#storage-status').textContent = `${events.length} local event(s).`;
}

async function exportCase() {
  const events = await getEvents();
  const bundle = { format: 'solari-case-json', version: 1, exported_at: new Date().toISOString(), events };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `solari-case-${Date.now()}.json`; a.click(); URL.revokeObjectURL(a.href);
}

async function importCase(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Case file exceeds 25 MB safety limit.');
  const data = JSON.parse(await file.text());
  if (data.format !== 'solari-case-json' || data.version !== 1 || !Array.isArray(data.events)) throw new Error('Unsupported case format.');
  const events = data.events.filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string');
  await saveEvents(events); await render();
}

document.querySelector('#solari-key').addEventListener('input', (event) => {
  solariKey = event.target.value;
  document.querySelector('#key-status').textContent = solariKey ? 'Solari key loaded in memory for this page session.' : 'No Solari key loaded.';
});
document.querySelector('#clear-key').addEventListener('click', () => { solariKey = ''; document.querySelector('#solari-key').value = ''; document.querySelector('#key-status').textContent = 'No Solari key loaded.'; });
document.querySelector('#fetch-source').addEventListener('click', async () => {
  const status = document.querySelector('#fetch-status');
  try {
    const url = new URL(document.querySelector('#source-url').value);
    if (url.protocol !== 'https:') throw new Error('Only HTTPS public sources are allowed.');
    status.textContent = 'Fetching…';
    const response = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const events = normalizeUsgs(payload, url.toString()); await saveEvents(events); await render();
    status.textContent = `Stored ${events.length} event(s).`;
  } catch (error) { status.textContent = `Fetch failed: ${error.message}`; }
});
document.querySelector('#refresh-events').addEventListener('click', render);
document.querySelector('#export-case').addEventListener('click', exportCase);
document.querySelector('#import-case').addEventListener('change', async (event) => { const file = event.target.files[0]; if (!file) return; try { await importCase(file); } catch (error) { alert(error.message); } event.target.value=''; });
document.querySelector('#clear-data').addEventListener('click', async () => { await clearEvents(); await render(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
render();
