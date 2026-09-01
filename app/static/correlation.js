async function loadCorrelationCandidates(){
  const state=document.getElementById('correlationState');
  const list=document.getElementById('correlationCandidates');
  if(!state||!list)return;
  try{
    const response=await fetch('/api/v1/correlation/candidates?limit=500');
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const payload=await response.json();
    list.replaceChildren();
    for(const item of payload.candidates.slice(0,100)){
      const card=document.createElement('article');card.className='execution-card';
      const title=document.createElement('strong');title.textContent=`${item.left_event_id} ↔ ${item.right_event_id} · score ${Number(item.score).toFixed(3)}`;
      const reasons=document.createElement('span');reasons.textContent=`${(item.reasons||[]).join(' · ')} · Δt ${Math.round(Number(item.time_delta_seconds||0))}s${item.distance_km==null?'':` · ${Number(item.distance_km).toFixed(1)} km`}`;
      card.append(title,reasons);list.appendChild(card);
    }
    state.textContent=`${payload.count} explainable candidate(s); source records remain independent.`;
  }catch(error){state.textContent=`Correlation view unavailable: ${error.message}`;}
}

const refresh=document.getElementById('refreshBtn');if(refresh)refresh.addEventListener('click',()=>setTimeout(loadCorrelationCandidates,0));
const collect=document.getElementById('collectBtn');if(collect)collect.addEventListener('click',()=>setTimeout(loadCorrelationCandidates,500));
loadCorrelationCandidates();
