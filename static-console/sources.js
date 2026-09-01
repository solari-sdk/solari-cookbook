const encoder = new TextEncoder();

async function sha256Text(value) {
  if (!crypto?.subtle) return null;
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
  return [...digest].map((byte)=>byte.toString(16).padStart(2,'0')).join('');
}

export const STATIC_SOURCES = {
  'usgs-earthquakes': {
    id: 'usgs-earthquakes',
    name: 'USGS Earthquakes',
    category: 'earthquake',
    method: 'feed',
    defaultUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
    accept: 'application/geo+json, application/json',
    capabilities: ['events','geospatial','public-feed','deterministic-normalization'],
    depends_on: [],
    normalize(payload, sourceUrl, acquisitionId) {
      return (payload.features || []).map((feature) => {
        const p = feature.properties || {};
        const coords = feature.geometry?.coordinates || [];
        return {
          id: `usgs-earthquakes:${feature.id || `${p.time}:${coords.join(',')}`}`,
          source_id: 'usgs-earthquakes', source_record_id: String(feature.id || ''), category: 'earthquake',
          title: p.mag == null ? (p.place || 'Earthquake') : `M${p.mag} — ${p.place || 'Earthquake'}`,
          summary: p.type || null, observed_at: p.time ? new Date(p.time).toISOString() : new Date(0).toISOString(),
          updated_at: p.updated ? new Date(p.updated).toISOString() : null,
          latitude: coords.length >= 2 ? Number(coords[1]) : null, longitude: coords.length >= 2 ? Number(coords[0]) : null,
          severity: p.mag >= 7 ? 'extreme' : p.mag >= 6 ? 'severe' : p.mag >= 5 ? 'high' : p.mag >= 4 ? 'moderate' : 'low',
          quality_score: 1, properties: { magnitude: p.mag ?? null, depth_km: coords[2] ?? null, tsunami: Boolean(p.tsunami), detail_url: p.url || null },
          evidence: [{ acquisition_id: acquisitionId, kind: 'observed', field: '*', source_url: sourceUrl, source_path: `features[id=${feature.id || ''}]` }],
        };
      });
    },
  },
};

export async function fetchStaticSource(sourceId, urlValue) {
  const adapter = STATIC_SOURCES[sourceId];
  if (!adapter) throw new Error('Unknown static source adapter.');
  const url = new URL(urlValue || adapter.defaultUrl);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS public sources are allowed.');
  const startedAt=new Date().toISOString();
  let response;
  try { response = await fetch(url, { headers: { Accept: adapter.accept }, mode: 'cors' }); }
  catch (error) { throw new Error(`Browser fetch unavailable (network or CORS). Use Solari Browser or a configured broker for this source. ${error.message}`); }
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
  const rawText=await response.text();
  let payload;
  try { payload=JSON.parse(rawText); } catch { throw new Error('Source returned invalid JSON.'); }
  const completedAt=new Date().toISOString();
  const acquisitionId=`${sourceId}:${startedAt}`;
  const events=adapter.normalize(payload,response.url||url.toString(),acquisitionId);
  const received=Array.isArray(payload?.features)?payload.features.length:Array.isArray(payload)?payload.length:events.length;
  const acquisition={
    id:acquisitionId,source_id:sourceId,method:adapter.method,requested_url:url.toString(),final_url:response.url||url.toString(),
    started_at:startedAt,completed_at:completedAt,status:'success',http_status:response.status,content_type:response.headers.get('content-type'),
    content_sha256:await sha256Text(rawText),metadata:{response_bytes:encoder.encode(rawText).byteLength,records_received:received,records_accepted:events.length,records_rejected:Math.max(0,received-events.length)},
  };
  return { source: adapter, url: url.toString(), events, acquisition, rawText };
}
