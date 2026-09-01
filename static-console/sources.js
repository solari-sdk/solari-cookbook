export const STATIC_SOURCES = {
  'usgs-earthquakes': {
    id: 'usgs-earthquakes',
    name: 'USGS Earthquakes',
    defaultUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
    accept: 'application/geo+json, application/json',
    normalize(payload, sourceUrl) {
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
          evidence: [{ kind: 'observed', source_url: sourceUrl, source_path: `features[id=${feature.id || ''}]` }],
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
  let response;
  try { response = await fetch(url, { headers: { Accept: adapter.accept }, mode: 'cors' }); }
  catch (error) { throw new Error(`Browser fetch unavailable (network or CORS). Use Solari Browser or a configured broker for this source. ${error.message}`); }
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
  return { source: adapter, url: url.toString(), events: adapter.normalize(await response.json(), url.toString()) };
}
