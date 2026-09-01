const workflowDefinition=document.getElementById('workflowDefinition');
const workflowGraph=document.getElementById('workflowGraph');
const workflowState=document.getElementById('workflowState');
const workflowOutput=document.getElementById('workflowOutput');
let previousWorkflowRun=null;

const DEFAULT_WORKFLOW={
  id:'current-event-summary',
  name:'Current event category summary',
  version:1,
  steps:[
    {id:'events',action:'current_events',depends_on:[]},
    {id:'categories',action:'category_counts',depends_on:['events']},
    {id:'count',action:'row_count',depends_on:['events']}
  ]
};
if(workflowDefinition&&!workflowDefinition.value.trim())workflowDefinition.value=JSON.stringify(DEFAULT_WORKFLOW,null,2);

function workflowRequest(){
  const playbook=JSON.parse(workflowDefinition.value);
  return{playbook,inputs:{limit:100},approvals:[]};
}
async function workflowApi(path,payload){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await response.json().catch(()=>({detail:`HTTP ${response.status}`}));
  if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail||data));
  return data;
}
function svgNode(tag){return document.createElementNS('http://www.w3.org/2000/svg',tag)}
function renderWorkflowGraph(graph){
  workflowGraph.replaceChildren();
  const width=Math.max(640,graph.nodes.length*180),height=220;
  workflowGraph.setAttribute('viewBox',`0 0 ${width} ${height}`);
  workflowGraph.setAttribute('role','img');
  workflowGraph.setAttribute('aria-label',`Workflow graph for ${graph.name}`);
  const positions=new Map();
  graph.topological_order.forEach((id,index)=>positions.set(id,{x:90+index*180,y:110}));
  for(const edge of graph.edges){
    const from=positions.get(edge.source),to=positions.get(edge.target);if(!from||!to)continue;
    const line=svgNode('line');line.setAttribute('x1',String(from.x+65));line.setAttribute('y1',String(from.y));line.setAttribute('x2',String(to.x-65));line.setAttribute('y2',String(to.y));line.setAttribute('stroke','currentColor');line.setAttribute('stroke-width','2');workflowGraph.append(line);
  }
  for(const node of graph.nodes){
    const pos=positions.get(node.id);if(!pos)continue;
    const group=svgNode('g');group.setAttribute('tabindex','0');group.setAttribute('aria-label',`${node.id}: ${node.action}`);
    const rect=svgNode('rect');rect.setAttribute('x',String(pos.x-65));rect.setAttribute('y',String(pos.y-32));rect.setAttribute('width','130');rect.setAttribute('height','64');rect.setAttribute('rx','8');rect.setAttribute('fill','none');rect.setAttribute('stroke','currentColor');rect.setAttribute('stroke-width','2');group.append(rect);
    const title=svgNode('text');title.setAttribute('x',String(pos.x));title.setAttribute('y',String(pos.y-5));title.setAttribute('text-anchor','middle');title.textContent=node.id;group.append(title);
    const action=svgNode('text');action.setAttribute('x',String(pos.x));action.setAttribute('y',String(pos.y+17));action.setAttribute('text-anchor','middle');action.setAttribute('font-size','11');action.textContent=node.action;group.append(action);
    workflowGraph.append(group);
  }
}
async function validateWorkflow(){
  try{
    workflowState.textContent='Validating workflow…';
    const graph=await workflowApi('/api/v1/workflows/validate',workflowRequest());
    renderWorkflowGraph(graph);workflowState.textContent=`Valid · ${graph.nodes.length} node(s), ${graph.edges.length} dependency edge(s).`;
    return graph;
  }catch(error){workflowGraph.replaceChildren();workflowState.textContent=`Workflow invalid: ${error.message}`;throw error}
}
async function executeWorkflow(path){
  try{
    await validateWorkflow();workflowState.textContent=path.endsWith('/rerun')?'Re-running against current persisted source data…':'Running against current persisted source data…';
    const result=await workflowApi(path,workflowRequest());
    if(previousWorkflowRun&&path.endsWith('/rerun'))result.previous_outputs=previousWorkflowRun.outputs;
    previousWorkflowRun=result;
    workflowOutput.textContent=JSON.stringify(result,null,2);
    workflowState.textContent=`${result.rerun?'Re-run':'Run'} ${result.status}; ${result.trace.length} traced step(s).`;
  }catch(error){workflowOutput.textContent='';workflowState.textContent=`Workflow execution failed: ${error.message}`}
}

document.getElementById('workflowRender')?.addEventListener('click',()=>validateWorkflow().catch(()=>{}));
document.getElementById('workflowRun')?.addEventListener('click',()=>executeWorkflow('/api/v1/workflows/run'));
document.getElementById('workflowRerun')?.addEventListener('click',()=>executeWorkflow('/api/v1/workflows/rerun'));
validateWorkflow().catch(()=>{});
