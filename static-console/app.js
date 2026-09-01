import { buildCase, validateCase, verifyCaseIntegrity } from './schema.js';
import { decryptCase, encryptCase } from './crypto.js';
import { caseCsv, caseGeoJson, caseGraphMl } from './exports.js';
import { assertSafeExport, scanForSecrets } from './security.js';
import { STATIC_SOURCES, fetchStaticSource } from './sources.js';
import { getAll, isPrivacyMode, purgeWorkspace, putMany, setPrivacyMode, storageEstimate } from './storage.js';

let solariKey = '';
let pendingImport = null;
let readOnlyEvents = null;

function sortedEvents(events) { return [...events].sort((a,b)=>String(b.observed_at).localeCompare(String(a.observed_at))); }
async function getEvents() { return sortedEvents(await getAll('events')); }

function drawWorld(events) {
  const canvas=document.querySelector('#world-map'); const ctx=canvas.getContext('2d'); const {width,height}=canvas;
  ctx.clearRect(0,0,width,height); ctx.fillStyle='#10151d'; ctx.fillRect(0,0,width,height); ctx.strokeStyle='#334155'; ctx.lineWidth=1;
  for(let lon=-180;lon<=180;lon+=30){const x=(lon+180)/360*width;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();}
  for(let lat=-90;lat<=90;lat+=30){const y=(90-lat)/180*height;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();}
  for(const event of events){if(!Number.isFinite(event.latitude)||!Number.isFinite(event.longitude))continue;const x=(event.longitude+180)/360*width;const y=(90-event.latitude)/180*height;const magnitude=Number(event.properties?.magnitude??0);const radius=Math.max(2,Math.min(10,2+magnitude));ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fillStyle='#e2e8f0';ctx.fill();}
}

function capabilitySnapshot(){return{
  secure_context:window.isSecureContext,indexed_db:'indexedDB'in window,opfs:Boolean(navigator.storage?.getDirectory),web_crypto:Boolean(window.crypto?.subtle),
  service_worker:'serviceWorker'in navigator,file_api:'File'in window&&'Blob'in window,file_system_access:'showOpenFilePicker'in window,
  storage_manager:Boolean(navigator.storage?.estimate),canvas:Boolean(document.createElement('canvas').getContext),online:navigator.onLine,
};}

async function renderCapabilities(){
  const caps=capabilitySnapshot(); document.querySelector('#capabilities').textContent=JSON.stringify(caps,null,2);
  document.querySelector('#network-status').textContent=caps.online?'Online — direct public sources may be available.':'Offline — local investigations remain available.';
  const estimate=await storageEstimate();
  if(!estimate.supported){document.querySelector('#quota-status').textContent='Storage quota estimate unavailable.';return;}
  const used=(estimate.usage/1024/1024).toFixed(1), quota=(estimate.quota/1024/1024).toFixed(1), percent=estimate.percent.toFixed(1);
  document.querySelector('#quota-status').textContent=`Browser storage: ${used} MiB / ${quota} MiB (${percent}%).${estimate.percent>=80?' Warning: storage usage is high.':''}`;
}

async function render(){
  const events=readOnlyEvents || await getEvents(); const body=document.querySelector('#events'); body.replaceChildren();
  for(const event of events.slice(0,500)){const row=document.createElement('tr');for(const value of[event.observed_at,event.category,event.title,event.source_id]){const cell=document.createElement('td');cell.textContent=value??'';row.appendChild(cell);}body.appendChild(row);}
  document.querySelector('#storage-status').textContent=readOnlyEvents?`${events.length} event(s) in isolated read-only import preview.`:`${events.length} ${isPrivacyMode()?'memory-only':'locally persisted'} event(s).`;
  drawWorld(events); await renderCapabilities();
}

function download(data,filename,type='application/json'){
  const body=typeof data==='string'?data:JSON.stringify(data,null,2); const blob=new Blob([body],{type}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

async function currentCase(){
  const [events,entities,relationships,evidence,savedViews]=await Promise.all(['events','entities','relationships','evidence','saved_views'].map(getAll));
  const title=document.querySelector('#case-title').value.trim()||'Portable investigation';
  return buildCase(sortedEvents(events),{title,entities,relationships,evidence,saved_views:savedViews});
}

async function exportCase(encrypted=false){
  const bundle=await currentCase(); assertSafeExport(bundle);
  if(!encrypted){download(bundle,`solari-case-${Date.now()}.json`);return;}
  if(!crypto.subtle)throw new Error('Web Crypto is unavailable in this browser/context.');
  const encryptedBundle=await encryptCase(bundle,document.querySelector('#case-passphrase').value); download(encryptedBundle,`solari-case-${Date.now()}.solari-case`);
}

async function exportDerived(kind){
  const bundle=await currentCase(); assertSafeExport(bundle); const stamp=Date.now();
  if(kind==='csv')download(caseCsv(bundle),`solari-case-${stamp}.csv`,'text/csv');
  if(kind==='geojson')download(caseGeoJson(bundle),`solari-case-${stamp}.geojson`,'application/geo+json');
  if(kind==='graphml')download(caseGraphMl(bundle),`solari-case-${stamp}.graphml`,'application/graphml+xml');
}

function incomingWins(existing,incoming){
  const current=Date.parse(existing.updated_at||existing.observed_at||0); const next=Date.parse(incoming.updated_at||incoming.observed_at||0); return !Number.isFinite(current)||!Number.isFinite(next)||next>=current;
}

async function analyzeImport(data){
  const existing=await getEvents(); const current=new Map(existing.map((e)=>[e.id,e])); let duplicate=0,newer=0,older=0;
  for(const event of data.events){const prior=current.get(event.id);if(!prior)continue;duplicate+=1;if(incomingWins(prior,event))newer+=1;else older+=1;}
  return {events:data.events.length,new_events:data.events.length-duplicate,duplicate_ids:duplicate,incoming_newer_or_equal:newer,incoming_older:older,entities:data.entities?.length||0,relationships:data.relationships?.length||0,evidence:data.evidence?.length||0};
}

async function prepareImport(file){
  if(file.size>25*1024*1024)throw new Error('Case file exceeds 25 MB safety limit.');
  let data=JSON.parse(await file.text());
  if(data.format==='solari-encrypted-case')data=await decryptCase(data,document.querySelector('#case-passphrase').value);
  validateCase(data); const integrity=await verifyCaseIntegrity(data); if(!integrity.legacy&&!integrity.verified)throw new Error(`Case integrity verification failed: ${integrity.mismatches.join('; ')}`);
  const secrets=scanForSecrets(data); if(secrets.length)throw new Error(`Import blocked by secret/session scan (${secrets.length} finding(s)).`);
  const analysis=await analyzeImport(data); pendingImport={data,analysis,integrity};
  document.querySelector('#import-preview').textContent=JSON.stringify({case:data.case?.title||null,schema_version:data.version,integrity,analysis,source_ids:data.manifest?.source_ids||[]},null,2);
  document.querySelector('#case-status').textContent='Import preview ready. Confirm merge or open read-only.';
}

async function confirmImport(){
  if(!pendingImport)throw new Error('No import is pending.'); const data=pendingImport.data; const current=new Map((await getEvents()).map((e)=>[e.id,e]));
  const merged=[]; for(const event of data.events){const prior=current.get(event.id);if(!prior||incomingWins(prior,event))merged.push(event);}
  await putMany('events',merged);
  for(const [store,key] of[['entities','entities'],['relationships','relationships'],['evidence','evidence'],['saved_views','saved_views']]) if(Array.isArray(data[key])&&data[key].length)await putMany(store,data[key]);
  if(data.case?.id)await putMany('cases',[{...data.case,id:data.case.id,imported_at:new Date().toISOString()}]);
  readOnlyEvents=null; pendingImport=null; document.querySelector('#import-preview').textContent=''; document.querySelector('#case-status').textContent=`Merged ${merged.length} incoming event record(s).`; await render();
}

async function openReadOnly(){if(!pendingImport)throw new Error('No import is pending.');readOnlyEvents=sortedEvents(pendingImport.data.events);document.querySelector('#case-status').textContent='Opened imported case in isolated read-only mode; local storage was not changed.';await render();}
function closeReadOnly(){readOnlyEvents=null;render();}

function fillSourceOptions(){const select=document.querySelector('#source-adapter');for(const source of Object.values(STATIC_SOURCES)){const option=document.createElement('option');option.value=source.id;option.textContent=source.name;select.appendChild(option);}select.addEventListener('change',()=>{document.querySelector('#source-url').value=STATIC_SOURCES[select.value].defaultUrl;});}

document.querySelector('#solari-key').addEventListener('input',(event)=>{solariKey=event.target.value;document.querySelector('#key-status').textContent=solariKey?'Solari key loaded in memory for this page session.':'No Solari key loaded.';});
document.querySelector('#clear-key').addEventListener('click',()=>{solariKey='';document.querySelector('#solari-key').value='';document.querySelector('#key-status').textContent='No Solari key loaded.';});
document.querySelector('#privacy-mode').addEventListener('change',async(event)=>{setPrivacyMode(event.target.checked);readOnlyEvents=null;document.querySelector('#privacy-status').textContent=event.target.checked?'Privacy mode enabled: new investigation state is memory-only.':'Persistent browser storage enabled.';await render();});
document.querySelector('#fetch-source').addEventListener('click',async()=>{const status=document.querySelector('#fetch-status');try{status.textContent='Fetching…';const result=await fetchStaticSource(document.querySelector('#source-adapter').value,document.querySelector('#source-url').value);await putMany('events',result.events);await putMany('source_state',[{id:result.source.id,last_success:new Date().toISOString(),url:result.url,count:result.events.length}]);await render();status.textContent=`Stored ${result.events.length} event(s).`;}catch(error){status.textContent=`Fetch failed: ${error.message}`;}});
document.querySelector('#refresh-events').addEventListener('click',()=>{readOnlyEvents=null;render();});
document.querySelector('#export-case').addEventListener('click',async()=>{try{await exportCase(false);document.querySelector('#case-status').textContent='Case JSON exported after secret/session scan.';}catch(error){document.querySelector('#case-status').textContent=error.message;}});
document.querySelector('#export-encrypted').addEventListener('click',async()=>{try{await exportCase(true);document.querySelector('#case-status').textContent='Encrypted case exported after integrity and secret/session checks.';}catch(error){document.querySelector('#case-status').textContent=error.message;}});
for(const kind of['csv','geojson','graphml'])document.querySelector(`#export-${kind}`).addEventListener('click',async()=>{try{await exportDerived(kind);}catch(error){document.querySelector('#case-status').textContent=error.message;}});
document.querySelector('#import-case').addEventListener('change',async(event)=>{const file=event.target.files[0];if(!file)return;try{await prepareImport(file);}catch(error){pendingImport=null;document.querySelector('#case-status').textContent=error.message;}event.target.value='';});
document.querySelector('#confirm-import').addEventListener('click',async()=>{try{await confirmImport();}catch(error){document.querySelector('#case-status').textContent=error.message;}});
document.querySelector('#open-readonly').addEventListener('click',async()=>{try{await openReadOnly();}catch(error){document.querySelector('#case-status').textContent=error.message;}});
document.querySelector('#close-readonly').addEventListener('click',closeReadOnly);
document.querySelector('#purge-data').addEventListener('click',async()=>{solariKey='';document.querySelector('#solari-key').value='';pendingImport=null;readOnlyEvents=null;await purgeWorkspace();document.querySelector('#case-status').textContent='Local database and application caches purged. Reloading storage on next use.';await render();});
window.addEventListener('online',renderCapabilities);window.addEventListener('offline',renderCapabilities);
if('serviceWorker'in navigator)navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
fillSourceOptions(); renderCapabilities(); render();
