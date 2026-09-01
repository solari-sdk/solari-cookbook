function dossierRow(label, value) {
  const row = document.createElement('div');
  row.className = 'execution-card';
  const strong = document.createElement('strong');
  strong.textContent = label;
  const span = document.createElement('span');
  span.textContent = value;
  row.append(strong, span);
  return row;
}

function renderRegionDossier() {
  const target = document.getElementById('regionDossier');
  if (!target) return;
  const events = Array.isArray(currentEvents) ? currentEvents : [];
  target.replaceChildren();
  if (!events.length) {
    target.append(dossierRow('Current query scope', 'No matching public-source events.'));
    return;
  }

  const sources = [...new Set(events.map((event) => event.source_id).filter(Boolean))].sort();
  const categories = [...new Set(events.map((event) => event.category).filter(Boolean))].sort();
  const times = events.map((event) => Date.parse(event.observed_at || '')).filter(Number.isFinite).sort((a, b) => a - b);
  const located = events.filter((event) => Number.isFinite(Number(event.latitude)) && Number.isFinite(Number(event.longitude)));

  target.append(dossierRow('Events / sources', `${events.length} event(s) across ${sources.length} source(s)`));
  target.append(dossierRow('Categories', categories.join(', ') || 'None'));
  target.append(dossierRow('Sources', sources.join(', ') || 'None'));
  if (times.length) target.append(dossierRow('Observed time span', `${new Date(times[0]).toISOString()} → ${new Date(times.at(-1)).toISOString()}`));
  if (located.length) {
    const lats = located.map((event) => Number(event.latitude));
    const lons = located.map((event) => Number(event.longitude));
    const bounds = `${Math.min(...lats).toFixed(3)}, ${Math.min(...lons).toFixed(3)} → ${Math.max(...lats).toFixed(3)}, ${Math.max(...lons).toFixed(3)}`;
    target.append(dossierRow('Observed coordinate bounds', bounds));
  }
  target.append(dossierRow('Interpretation boundary', 'Summary is derived only from the currently filtered structured public-source records; no country, jurisdiction, or causal attribution is inferred.'));
}

const dossierEvents = document.getElementById('events');
if (dossierEvents) new MutationObserver(renderRegionDossier).observe(dossierEvents, { childList: true });
renderRegionDossier();
