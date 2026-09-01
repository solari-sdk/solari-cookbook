const solariNode=(tag,text,className)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element};

async function refreshSolariExecutions(){
  const target=document.getElementById('solariExecutions');
  const state=document.getElementById('solariExecutionState');
  if(!target||!state)return;
  state.textContent='Loading Browser / Sandbox / Desktop execution history…';
  try{
    const response=await fetch('/api/v1/solari/executions?limit=50');
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const executions=await response.json();
    target.replaceChildren();
    for(const execution of executions){
      const card=solariNode('article',undefined,'execution-item');
      const heading=solariNode('div',undefined,'execution-head');
      heading.append(solariNode('strong',`${String(execution.kind||'solari').toUpperCase()} · ${execution.status||'unknown'}`),solariNode('span',execution.completed_at||''));
      card.append(heading);
      const summary=execution.summary&&typeof execution.summary==='object'?execution.summary:{};
      const detail=[execution.target,execution.session_id?`session ${execution.session_id}`:null,summary.operation,summary.workflow,summary.recording_requested?`recording requested${summary.replay_available?' · replay available':' · replay unavailable'}`:null].filter(Boolean).join(' · ');
      if(detail)card.append(solariNode('p',detail));
      const artifacts=Array.isArray(execution.artifact_sha256s)?execution.artifact_sha256s:[];
      if(artifacts.length){
        const links=solariNode('div',undefined,'artifact-links');
        for(const digest of artifacts){
          if(!/^[0-9a-f]{64}$/i.test(String(digest)))continue;
          const link=solariNode('a',`artifact ${String(digest).slice(0,12)}…`);
          link.href=`/api/v1/artifacts/${encodeURIComponent(digest)}/preview`;
          link.target='_blank';
          link.rel='noopener noreferrer';
          links.append(link);
        }
        card.append(links);
      }
      if(execution.error_type||execution.error_message)card.append(solariNode('code',[execution.error_type,execution.error_message].filter(Boolean).join(' · ')));
      target.append(card);
    }
    state.textContent=`${executions.length} recent Solari execution(s). Artifact links expose retained HTML, screenshots, replay recordings, or sandbox transcripts when present.`;
  }catch(error){
    target.replaceChildren();
    state.textContent=`Solari execution history unavailable: ${error.message}`;
  }
}

const solariRefresh=document.getElementById('refreshBtn');
if(solariRefresh)solariRefresh.addEventListener('click',()=>setTimeout(refreshSolariExecutions,0));
refreshSolariExecutions();
