const map=L.map('map',{worldCopyJump:true}).setView([18,0],2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© OpenStreetMap contributors'}).addTo(map);
const markers=L.layerGroup().addTo(map);let currentEvents=[];const $=id=>document.getElementById(id);
async function api(path,options){const r=await fetch(path,options);if(!r.ok)throw new Error(`${r.status} ${await r.text()}`);return r.json()}
function decodeRow(row){return{...row,properties:JSON.parse(row.properties_json||'{}'),evidence:JSON.parse(row.evidence_json||'[]')}}
function ageLabel(value){if(!value)return'—';const seconds=Math.max(0,(Date.now()-Date.parse(value))/1000);if(seconds<60)return`${Math.round(seconds)}s`;if(seconds<3600)return`${Math.round(seconds/60)}m`;if(seconds<86400)return`${Math.round(seconds/3600)}h`;return`${Math.round(seconds/86400)}d`}
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el}
function render(events){
  const minQuality=Number($('qualityFilter').value||0);currentEvents=events.map(decodeRow).filter(e=>Number(e.quality_score??1)>=minQuality);markers.clearLayers();$('events').replaceChildren();$('eventCount').textContent=currentEvents.length;$('latestEvent').textContent=currentEvents[0]?.observed_at?new Date(currentEvents[0].observed_at).toLocaleString():'—';
  const selectedCategory=$('categoryFilter').value;const cats=[...new Set(currentEvents.map(e=>e.category))].sort();$('categoryFilter').replaceChildren(new Option('All',''),...cats.map(c=>new Option(c,c)));$('categoryFilter').value=cats.includes(selectedCategory)?selectedCategory:'';
  for(const e of currentEvents){
    if(e.latitude!==null&&e.longitude!==null){L.circleMarker([e.latitude,e.longitude],{radius:6,weight:1,fillOpacity:.7}).addTo(markers).bindTooltip(e.title)}
    const card=node('button',undefined,'event-card');card.type='button';card.append(node('strong',e.title));const meta=node('div',undefined,'event-meta');for(const value of[e.category,new Date(e.observed_at).toLocaleString(),e.severity||'unrated',`quality ${Number(e.quality_score??1).toFixed(2)}`,`age ${ageLabel(e.observed_at)}`])meta.append(node('span',value));card.append(meta);card.onclick=()=>{$('evidence').textContent=JSON.stringify(e,null,2)};$('events').append(card)
  }
}
async function loadSources(){const src=await api('/api/v1/sources');$('sourceCount').textContent=src.length;$('sourceFilter').replaceChildren(new Option('All',''),...src.map(s=>new Option(s.name,s.id)))}
function isoLocal(value){if(!value)return null;const date=new Date(value);return Number.isNaN(date.getTime())?null:date.toISOString()}
async function refresh(){
  const p=new URLSearchParams();const s=$('sourceFilter').value,c=$('categoryFilter').value,l=$('limitFilter').value,q=$('searchFilter').value.trim();const start=isoLocal($('startFilter').value),end=isoLocal($('endFilter').value);if(s)p.set('source_id',s);if(c)p.set('category',c);if(q)p.set('q',q);if(start)p.set('start',start);if(end)p.set('end',end);p.set('limit',l);$('streamState').textContent='Loading…';
  try{render(await api('/api/v1/events?'+p));$('streamState').textContent='Current';await loadOperations()}catch(e){$('streamState').textContent=e.message}
}
async function loadOperations(){
  const [health,acquisitions]=await Promise.all([api('/api/v1/source-health'),api('/api/v1/acquisitions?limit=20')]);$('staleCount').textContent=health.filter(item=>item.stale).length;
  const healthBody=$('sourceHealth');healthBody.replaceChildren();for(const item of health){const tr=document.createElement('tr');if(item.stale)tr.className='stale';for(const value of[item.source_id,item.last_status+(item.stale?' / stale':''),ageLabel(item.last_completed_at),item.runs,item.failures,item.events_stored,item.last_duration_ms==null?'—':`${Math.round(item.last_duration_ms)} ms`])tr.append(node('td',String(value??'—')));healthBody.append(tr)}
  const list=$('executions');list.replaceChildren();for(const item of acquisitions){const card=node('article',undefined,'execution-card');card.append(node('strong',`${item.source_id} · ${item.status}`));card.append(node('span',`${new Date(item.completed_at).toLocaleString()} · ${item.duration_ms==null?'—':Math.round(item.duration_ms)+' ms'} · ${item.http_status??item.error_type??'no HTTP status'}`));if(item.error_message)card.append(node('code',item.error_message));list.append(card)}
}
async function collect(){$('collectBtn').disabled=true;$('collectBtn').textContent='Collecting…';try{await api('/api/v1/collect/usgs-earthquakes',{method:'POST'});await refresh()}finally{$('collectBtn').disabled=false;$('collectBtn').textContent='Collect USGS now'}}
async function boot(){try{const [h,r]=await Promise.all([api('/api/v1/health'),api('/api/v1/ready')]);$('health').textContent=`${h.status.toUpperCase()} · ${r.status.replace('_',' ').toUpperCase()} · ${h.sources_registered} source(s)`}catch(e){$('health').textContent='API unavailable'}await loadSources();await refresh()}
$('refreshBtn').onclick=refresh;$('collectBtn').onclick=collect;$('sourceFilter').onchange=refresh;$('categoryFilter').onchange=refresh;$('qualityFilter').onchange=refresh;$('searchFilter').onkeydown=e=>{if(e.key==='Enter')refresh()};$('startFilter').onchange=refresh;$('endFilter').onchange=refresh;boot();
