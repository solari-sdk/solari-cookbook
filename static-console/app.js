import { buildCase, validateCase } from './schema.js';
import { decryptCase, encryptCase } from './crypto.js';

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

function stableId(sourceId, recordId) { return `${sourceId}:${recordId}`; }

function normalizeUsgs(payload, sourceUrl) {
  return (payload.features || []).map((feature) => {
    const p = feature.properties || {};
    const coords = (feature.geometry && feature.geometry.coordinates) || [];
    return {
      id: stableId('usgs-earthquakes', feature.id || `${p.time}:${coords.join(',')}`), source_id: 'usgs-earthquakes',
      source_record_id: String(feature.id || ''), category: 'earthquake',
      title: p.mag == null ? (p.place || 'Earthquake') : `M${p.mag} — ${p.place || 'Earthquake'}`,
      summary: p.type || null, observed_at: p.time ? new Date(p.time).toISOString() : new Date(0).toISOString(),
      updated_at: p.updated ? new Date(p.updated).toISOString() : null,
      latitude: coords.length >= 2 ? Number(coords[1]) : null, longitude: coords.length >= 2 ? Number(coords[0]) : null,
      severity: p.mag >= 7 ? 'extreme' : p.mag >= 6 ? 'severe' : p.mag >= 5 ? 'high' : p.mag >= 4 ? 'moderate' : 'low', quality_score: 1,
      properties: { magnitude: p.mag ?? null, depth_km: coords[2] ?? null, tsunami: Boolean(p.tsunami), detail_url: p.url || null },
      evidence: [{ kind: 'observed', source_url: sourceUrl, source_path: `features[id=${feature.id || ''}]` }],
    };
  });
}

async function saveEvents(events) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_EVENTS, 'readwrite'); const store = transaction.objectStore(STORE_EVENTS);
    for (const event of events) store.put(event);
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
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

async function clearEvents() { await tx(STORE_EVENTS, 'readwrite', (store) => store.clear()); }

function drawWorld(events) {
  const canvas = document.querySelector('#world-map'); const ctx = canvas.getContext('2d');
  const width = canvas.width; const height = canvas.height;
  ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#10151d'; ctx.fillRect(0,0,width,height);
  ctx.strokeStyle = '#334155'; ctx.lineWidth = 1;
  for (let lon=-180; lon<=180; lon+=30) { const x=(lon+180)/360*width; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,height); ctx.stroke(); }
  for (let lat=-90; lat<=90; lat+=30) { const y=(90-lat)/180*height; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(width,y); ctx.stroke(); }
  for (const event of events) {
    if (!Number.isFinite(event.latitude) || !Number.isFinite(event.longitude)) continue;
    const x=(event.longitude+180)/360*width; const y=(90-event.latitude)/180*height;
    const magnitude=Number(event.properties?.magnitude ?? 0); const radius=Math.max(2,Math.min(10,2+magnitude));
    ctx.beginPath(); ctx.arc(x,y,radius,0,Math.PI*2); ctx.fillStyle='#e2e8f0'; ctx.fill();
  }
}

function renderCapabilities() {
  const caps = {
    secure_context: window.isSecureContext,
    indexed_db: 'indexedDB' in window,
    web_crypto: Boolean(window.crypto?.subtle),
    service_worker: 'serviceWorker' in navigator,
    file_api: 'File' in window && 'Blob' in window,
    canvas: Boolean(document.createElement('canvas').getContext),
    online: navigator.onLine,
  };
  document.querySelector('#capabilities').textContent = JSON.stringify(caps, null, 2);
}

async function render() {
  const events = await getEvents(); const body = document.querySelector('#events'); body.replaceChildren();
  for (const event of events.slice(0, 500)) {
    const row = document.createElement('tr');
    for (const value of [event.observed_at, event.category, event.title, event.source_id]) { const cell=document.createElement('td'); cell.textContent=value ?? ''; row.appendChild(cell); }
    body.appendChild(row);
  }
  document.querySelector('#storage-status').textContent = `${events.length} local event(s).`;
  drawWorld(events);
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportCase(encrypted = false) {
  const events = await getEvents(); const title = document.querySelector('#case-title').value.trim() || 'Portable investigation';
  const caseData = buildCase(events, { title });
  if (!encrypted) { downloadJson(caseData, `solari-case-${Date.now()}.json`); return; }
  if (!crypto.subtle) throw new Error('Web Crypto is unavailable in this browser/context.');
  const passphrase = document.querySelector('#case-passphrase').value;
  const bundle = await encryptCase(caseData, passphrase);
  downloadJson(bundle, `solari-case-${Date.now()}.solari-case`);
}

async function importCase(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('Case file exceeds 25 MB safety limit.');
  let data = JSON.parse(await file.text());
  if (data.format === 'solari-encrypted-case') {
    const passphrase = document.querySelector('#case-passphrase').value;
    data = await decryptCase(data, passphrase);
  }
  validateCase(data);
  const events = data.events.filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string');
  await saveEvents(events); await render();
  document.querySelector('#case-status').textContent = `Imported ${events.length} event(s) from ${data.case?.title || 'case'}.`;
}

document.querySelector('#solari-key').addEventListener('input', (event) => { solariKey=event.target.value; document.querySelector('#key-status').textContent=solariKey?'Solari key loaded in memory for this page session.':'No Solari key loaded.'; });
document.querySelector('#clear-key').addEventListener('click', () => { solariKey=''; document.querySelector('#solari-key').value=''; document.querySelector('#key-status').textContent='No Solari key loaded.'; });
document.querySelector('#fetch-source').addEventListener('click', async () => {
  const status=document.querySelector('#fetch-status');
  try {
    const url=new URL(document.querySelector('#source-url').value); if (url.protocol!=='https:') throw new Error('Only HTTPS public sources are allowed.');
    status.textContent='Fetching…'; const response=await fetch(url,{headers:{Accept:'application/geo+json, application/json'}}); if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload=await response.json(); const events=normalizeUsgs(payload,url.toString()); await saveEvents(events); await render(); status.textContent=`Stored ${events.length} event(s).`;
  } catch(error) { status.textContent=`Fetch failed: ${error.message}`; }
});
document.querySelector('#refresh-events').addEventListener('click', render);
document.querySelector('#export-case').addEventListener('click', async () => { try { await exportCase(false); } catch(error) { document.querySelector('#case-status').textContent=error.message; } });
document.querySelector('#export-encrypted').addEventListener('click', async () => { try { await exportCase(true); document.querySelector('#case-status').textContent='Encrypted case exported.'; } catch(error) { document.querySelector('#case-status').textContent=error.message; } });
document.querySelector('#import-case').addEventListener('change', async (event) => { const file=event.target.files[0]; if(!file)return; try{await importCase(file);}catch(error){document.querySelector('#case-status').textContent=error.message;} event.target.value=''; });
document.querySelector('#clear-data').addEventListener('click', async () => { await clearEvents(); await render(); });
window.addEventListener('online', renderCapabilities); window.addEventListener('offline', renderCapabilities);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
renderCapabilities(); render();
