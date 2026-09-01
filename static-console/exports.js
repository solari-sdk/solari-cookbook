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
