import { renderGraph } from './graph.js';
import { getAll } from './storage.js';

async function refreshGraph(){
  const svg=document.querySelector('#knowledge-graph');
  if(!svg)return;
  const[entities,relationships]=await Promise.all([getAll('entities'),getAll('relationships')]);
  const layout=renderGraph(svg,entities,relationships,{onSelect:(entity)=>{document.querySelector('#graph-selection').textContent=JSON.stringify(entity,null,2);}});
  document.querySelector('#graph-status').textContent=`${layout.nodes.length} entity node(s), ${layout.edges.length} relationship edge(s).${layout.truncated?' View bounded for responsiveness.':''}`;
}

const status=document.querySelector('#storage-status');
if(status)new MutationObserver(()=>refreshGraph().catch(()=>{})).observe(status,{childList:true,characterData:true,subtree:true});
window.addEventListener('focus',()=>refreshGraph().catch(()=>{}));
refreshGraph().catch((error)=>{const status=document.querySelector('#graph-status');if(status)status.textContent=`Graph unavailable: ${error.message}`;});
