const advNode=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el};
async function advApi(path){const response=await fetch(path);if(!response.ok)throw new Error(`${response.status} ${await response.text()}`);return response.json()}

let entitySearchTimer=null;
async function refreshEntitySearch(){
  const target=document.getElementById('entitySearchResults');
  const state=document.getElementById('entitySearchState');
  const query=document.getElementById('searchFilter').value.trim();
  const minConfidence=Number(document.getElementById('confidenceFilter').value||0);
  if(!query){target.replaceChildren();state.textContent='Use the shared Search field to query both events and entities.';return;}
  state.textContent='Searching entities…';
  try{
    const params=new URLSearchParams({limit:'100',q:query});
    const entities=(await advApi(`/api/v1/entities?${params}`)).map((row)=>{let properties={};try{properties=JSON.parse(row.properties_json||'{}')}catch{}return{...row,properties}}).filter((entity)=>Number(entity.confidence??1)>=minConfidence);
    target.replaceChildren();
    for(const entity of entities){
      const button=advNode('button',undefined,'entity-result');button.type='button';
      button.append(advNode('strong',entity.label||entity.id),advNode('span',`${entity.type||'entity'} · confidence ${Number(entity.confidence??1).toFixed(2)}`));
      button.addEventListener('click',()=>{document.getElementById('evidence').textContent=JSON.stringify(entity,null,2);if(typeof window.selectGraphEntity==='function')window.selectGraphEntity(entity)});
      target.append(button);
    }
    state.textContent=`${entities.length} matching entity/entities at confidence ≥ ${minConfidence.toFixed(2)}.`;
  }catch(error){state.textContent=`Entity search unavailable: ${error.message}`}
}
function scheduleEntitySearch(){clearTimeout(entitySearchTimer);entitySearchTimer=setTimeout(refreshEntitySearch,180)}

function timelineRange(jobs){
  const values=[];
  for(const job of jobs){for(const value of[job.started_at,job.completed_at]){const time=Date.parse(value||'');if(Number.isFinite(time))values.push(time)}}
  if(!values.length){const now=Date.now();return[now-1,now]}
  const min=Math.min(...values),max=Math.max(...values);return[min,max===min?min+1:max];
}
async function refreshJobTimeline(){
  const target=document.getElementById('jobTimeline');const state=document.getElementById('jobTimelineState');state.textContent='Loading…';
  try{
    const jobs=await advApi('/api/v1/jobs?limit=40');target.replaceChildren();
    const[min,max]=timelineRange(jobs);const span=Math.max(1,max-min);
    for(const job of jobs){
      const row=advNode('article',undefined,'job-row');const heading=advNode('div',undefined,'job-heading');heading.append(advNode('strong',job.name||job.id),advNode('span',`${job.status} · ${job.attempts} attempt(s)`));row.append(heading);
      const lane=advNode('div',undefined,'job-lane');const start=Date.parse(job.started_at||job.created_at||'');const end=Date.parse(job.completed_at||job.started_at||job.created_at||'');
      if(Number.isFinite(start)&&Number.isFinite(end)){
        const bar=advNode('div',undefined,`job-bar ${job.status==='failed'?'failed':''}`);bar.style.left=`${Math.max(0,(start-min)/span*100)}%`;bar.style.width=`${Math.max(1,(Math.max(end,start)-start)/span*100)}%`;
        const durations=Array.isArray(job.attempt_durations_ms)?job.attempt_durations_ms:[];const total=durations.reduce((sum,value)=>sum+Math.max(0,Number(value)||0),0);
        if(total>0){for(const duration of durations){const segment=advNode('span',undefined,'attempt-segment');segment.style.flexGrow=String(Math.max(.001,Number(duration)||0));bar.append(segment)}}
        lane.append(bar);
      }
      row.append(lane);
      const detail=advNode('div',undefined,'job-detail');const durations=(job.attempt_durations_ms||[]).map((value)=>`${Math.round(Number(value)||0)} ms`).join(', ');detail.append(advNode('span',`${job.source_id||'general'} · ${job.started_at||'no start'} → ${job.completed_at||'no completion'}`));if(durations)detail.append(advNode('code',`attempts: ${durations}`));if(job.failure_class||job.error_type||job.error_message)detail.append(advNode('code',[job.failure_class,job.error_type,job.error_message].filter(Boolean).join(' · ')));row.append(detail);target.append(row);
    }
    state.textContent=`${jobs.length} recent job execution(s); bars show relative start/duration and attempt segments.`;
  }catch(error){state.textContent=`Job timeline unavailable: ${error.message}`}
}

async function renderProvenanceChain(){
  const output=document.getElementById('provenanceChain');const raw=document.getElementById('evidence').textContent;let selected;
  try{selected=JSON.parse(raw)}catch{output.textContent='Select an event to trace its provenance.';return}
  if(!selected?.source_id||!Array.isArray(selected.evidence)){output.textContent='The selected object does not expose an event evidence chain.';return}
  const acquisitionIds=[...new Set(selected.evidence.map((item)=>item.acquisition_id).filter(Boolean))];
  let acquisitions=[];try{acquisitions=await advApi(`/api/v1/acquisitions?limit=100&source_id=${encodeURIComponent(selected.source_id)}`)}catch{}
  const byId=new Map(acquisitions.map((item)=>[item.id,item]));output.replaceChildren();
  const source=advNode('div',undefined,'chain-step');source.append(advNode('strong',`Source · ${selected.source_id}`),advNode('span',selected.source_record_id||'source record'));output.append(source);
  for(const acquisitionId of acquisitionIds){const acquisition=byId.get(acquisitionId);const step=advNode('div',undefined,'chain-step');step.append(advNode('strong',`Acquisition · ${acquisitionId}`));if(acquisition)step.append(advNode('span',`${acquisition.method||'acquisition'} · ${acquisition.completed_at||''} · SHA-256 ${acquisition.content_sha256||'not retained'}`));for(const evidence of selected.evidence.filter((item)=>item.acquisition_id===acquisitionId))step.append(advNode('code',`${evidence.kind||'evidence'} · ${evidence.field||'*'} · ${evidence.source_path||'source path unavailable'}`));output.append(step)}
  const normalized=advNode('div',undefined,'chain-step');normalized.append(advNode('strong',`Normalized event · ${selected.id}`),advNode('span',`quality ${Number(selected.quality_score??1).toFixed(2)} · observed ${selected.observed_at||'unknown'}`));output.append(normalized);
}

const search=document.getElementById('searchFilter');search.addEventListener('input',scheduleEntitySearch);search.addEventListener('keydown',(event)=>{if(event.key==='Enter')refreshEntitySearch()});document.getElementById('confidenceFilter').addEventListener('change',refreshEntitySearch);
document.getElementById('refreshBtn').addEventListener('click',()=>setTimeout(()=>{refreshEntitySearch();refreshJobTimeline()},0));
new MutationObserver(()=>renderProvenanceChain()).observe(document.getElementById('evidence'),{childList:true,characterData:true,subtree:true});
refreshEntitySearch();refreshJobTimeline();renderProvenanceChain();
