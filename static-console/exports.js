function escapeXml(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;'); }
function csvCell(value) { const text=String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replaceAll('"','""')}"` : text; }

export function caseCsv(bundle) {
  const fields=['id','source_id','source_record_id','category','title','observed_at','updated_at','latitude','longitude','severity','quality_score'];
  return [fields.join(','), ...bundle.events.map((e)=>fields.map((f)=>csvCell(e[f])).join(','))].join('\n');
}

export function caseGeoJson(bundle) {
  return { type:'FeatureCollection', features: bundle.events.filter((e)=>Number.isFinite(e.latitude)&&Number.isFinite(e.longitude)).map((e)=>({type:'Feature',id:e.id,geometry:{type:'Point',coordinates:[e.longitude,e.latitude]},properties:Object.fromEntries(Object.entries(e).filter(([key])=>!['latitude','longitude'].includes(key)))})) };
}

export function caseGraphMl(bundle) {
  const nodes=(bundle.entities||[]).map((entity)=>`<node id="${escapeXml(entity.id)}"><data key="label">${escapeXml(entity.label||entity.name||entity.id)}</data></node>`).join('');
  const edges=(bundle.relationships||[]).map((relationship,index)=>`<edge id="${escapeXml(relationship.id||`r${index}`)}" source="${escapeXml(relationship.source_id||relationship.source)}" target="${escapeXml(relationship.target_id||relationship.target)}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><graphml xmlns="http://graphml.graphdrawing.org/xmlns"><key id="label" for="node" attr.name="label" attr.type="string"/><graph id="case" edgedefault="directed">${nodes}${edges}</graph></graphml>`;
}

export function caseReportHtml(bundle) {
  const events=[...(bundle.events||[])].sort((a,b)=>String(a.observed_at||'').localeCompare(String(b.observed_at||'')));
  const sourceIds=bundle.manifest?.source_ids||[...new Set(events.map((event)=>event.source_id).filter(Boolean))].sort();
  const rows=events.map((event)=>`<tr><td>${escapeXml(event.observed_at)}</td><td>${escapeXml(event.category)}</td><td>${escapeXml(event.title)}</td><td>${escapeXml(event.source_id)}</td><td>${escapeXml(event.severity)}</td></tr>`).join('');
  const evidence=(bundle.evidence||[]).map((item)=>`<li><code>${escapeXml(item.id||item.event_id||'evidence')}</code> ${escapeXml(item.kind||'')} ${escapeXml(item.source_url||item.note||'')}</li>`).join('');
  const manifest=escapeXml(JSON.stringify(bundle.manifest||{},null,2));
  const title=escapeXml(bundle.case?.title||'Portable investigation');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:.4rem;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:1rem}code{font-family:ui-monospace,monospace}</style></head><body><h1>${title}</h1><p>Generated offline from portable case data. Events: ${events.length}. Sources: ${escapeXml(sourceIds.join(', ')||'none')}.</p><h2>Timeline</h2><table><thead><tr><th>Observed</th><th>Category</th><th>Title</th><th>Source</th><th>Severity</th></tr></thead><tbody>${rows}</tbody></table><h2>Evidence appendix</h2>${evidence?`<ul>${evidence}</ul>`:'<p>No case-level evidence entries were bundled.</p>'}<h2>Reproducibility manifest</h2><pre>${manifest}</pre></body></html>`;
}
