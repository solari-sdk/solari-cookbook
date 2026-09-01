function ends(edge){return[edge.source_entity_id||edge.source_id||edge.source,edge.target_entity_id||edge.target_id||edge.target];}

export function graphLayout(entities,relationships,{width=720,height=520,maxNodes=100,maxEdges=250}={}){
  const nodes=[...(entities||[])].slice(0,maxNodes);
  const ids=new Set(nodes.map((node)=>node.id));
  const edges=(relationships||[]).filter((edge)=>{const[source,target]=ends(edge);return ids.has(source)&&ids.has(target);}).slice(0,maxEdges);
  const cx=width/2,cy=height/2,radius=Math.max(70,Math.min(width,height)*0.36);
  const positioned=nodes.map((node,index)=>{const angle=(Math.PI*2*index/Math.max(nodes.length,1))-Math.PI/2;return{...node,x:cx+Math.cos(angle)*radius,y:cy+Math.sin(angle)*radius};});
  return{nodes:positioned,edges,width,height,truncated:(entities||[]).length>nodes.length||(relationships||[]).length>edges.length};
}

function svgElement(name,attrs={}){const element=document.createElementNS('http://www.w3.org/2000/svg',name);for(const[key,value]of Object.entries(attrs))element.setAttribute(key,String(value));return element;}

export function renderGraph(svg,entities,relationships,{onSelect}={}){
  const layout=graphLayout(entities,relationships,{width:Number(svg.getAttribute('viewBox')?.split(' ')[2]||720),height:Number(svg.getAttribute('viewBox')?.split(' ')[3]||520)});
  svg.replaceChildren();
  const positions=new Map(layout.nodes.map((node)=>[node.id,node]));
  for(const edge of layout.edges){const[source,target]=ends(edge);const a=positions.get(source),b=positions.get(target);const line=svgElement('line',{x1:a.x.toFixed(1),y1:a.y.toFixed(1),x2:b.x.toFixed(1),y2:b.y.toFixed(1),class:'graph-edge'});const title=svgElement('title');title.textContent=edge.type||'relationship';line.appendChild(title);svg.appendChild(line);}
  for(const node of layout.nodes){const group=svgElement('g',{class:'graph-node',tabindex:'0',role:'button','aria-label':`${node.type||'entity'}: ${node.label||node.name||node.id}`});const circle=svgElement('circle',{cx:node.x.toFixed(1),cy:node.y.toFixed(1),r:10});const label=svgElement('text',{x:(node.x+14).toFixed(1),y:(node.y+4).toFixed(1)});label.textContent=String(node.label||node.name||node.id).slice(0,40);group.append(circle,label);const select=()=>{svg.querySelectorAll('.graph-node').forEach((item)=>item.classList.remove('selected'));group.classList.add('selected');if(onSelect)onSelect(node);};group.addEventListener('click',select);group.addEventListener('keydown',(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select();}});svg.appendChild(group);}
  return layout;
}
