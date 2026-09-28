'use strict';
// Authorized bounded public HITO subset. See docs/public-subset.md.
// The four routines below retain their accepted source bodies verbatim.
const crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const store={sha};
const id=(tag,x)=>tag+':'+sha(Buffer.from(JSON.stringify(x)));
function safeRelative(s){return typeof s==='string'&&s.length>0&&s.length<512&&!s.includes('\\')&&!s.includes(':')&&!s.startsWith('/')&&s.split('/').every(x=>x&&x!=='.'&&x!=='..');}
// The public adapter always supplies a reader; no private acquisition closure.
function readBounded(){throw Error('EXPLICIT_PUBLIC_READER_REQUIRED');}
function structure(){throw Error('UNBOUNDED_STRUCTURE_UNAVAILABLE');}
function artifact(root,rel,dimension,authority,observation){return {artifactIdentity:id('artifact',[root,rel,observation.contentSha256??observation.reason]),path:rel,dimension,authority,...observation};}

function claimsFor(a,subject){
 if(a.state!=='OBSERVED')return [];
 const statements=[{key:'artifact',value:a.authority==='DOCUMENTARY_EVIDENCE_ONLY'?'Documentary content captured; statements not verified':a.authority==='STRUCTURAL_DECLARATION'?'Structural declaration captured; runtime not verified':'Physical bytes or bounded directory entries observed; behavior not verified'}];
 if(a.path==='package.json'){
  try{const p=JSON.parse(a.content);for(const k of ['name','version','main','workspaces','dependencies','devDependencies','scripts','bin'])if(Object.hasOwn(p,k))statements.push({key:k,value:p[k]});}catch{}
 }
 if(a.authority==='DOCUMENTARY_EVIDENCE_ONLY'){
  // Only explicit documentary entrypoint statements are compared; arbitrary prose stays documentary.
  for(const line of a.content.split(/\r?\n/).slice(0,256)){const match=/^entrypoint:\s*([^\s]+)\s*$/i.exec(line);if(match&&safeRelative(match[1]))statements.push({key:'entrypoint',value:match[1]});}
 }
 const evidenceIdentity=id('evidence',[a.artifactIdentity,a.contentSha256]);
 return statements.map(s=>{const claimIdentity=id('claim',[subject,a.artifactIdentity,s]);return {claimIdentity,semanticDimension:a.dimension,statement:s,evidenceIdentities:[evidenceIdentity],artifactIdentities:[a.artifactIdentity],contentIdentities:[a.contentSha256],supportEdgeIdentity:id('support',[a.artifactIdentity,evidenceIdentity,claimIdentity]),scope:{subjectIdentity:subject,path:a.path},authority:a.authority,verification:a.authority==='STRUCTURAL_DECLARATION'?'STRUCTURALLY_SUPPORTED':a.authority==='PHYSICAL_OBSERVATION'?'PHYSICALLY_OBSERVED':'NOT_VERIFIED',currentness:'CURRENT',currentnessBasis:'Supporting artifact identity at bounded refresh; assertion truth is separate',invalidationDependencies:[a.path],canonicalAuthority:false};});
}

function refresh(root,cached,reader=readBounded){
 const budget={files:0,bytes:0},changed=[],uncertain=[],observations=[];
 for(const a of cached.artifacts){const now=a.path==='.'&&reader===readBounded?structure(root):reader(root,a.path,budget);observations.push({path:a.path,state:now.state,contentSha256:now.contentSha256??null,reason:now.reason??null});if(now.state==='INDETERMINATE')uncertain.push(a.path);else if(now.state!==a.state||now.contentSha256!==a.contentSha256||now.reason!==a.reason)changed.push(a.path);}
 const claims=cached.claims.map(c=>({...c,currentness:c.invalidationDependencies.some(p=>changed.includes(p))?'STALE':c.invalidationDependencies.some(p=>uncertain.includes(p))?'UNKNOWN':'CURRENT'}));
 return {claims,changed,uncertain,observations,cost:budget,semanticClaimsRebuilt:0,scope:'Only cached supporting paths and bounded top-level entries; no recursive scan. Receipt validation is separate from refresh.'};
}

function assessAcquisitionContradictions(claims,artifacts,upstreamNext){
 const items=[];
 const main=claims.find(c=>c.scope.path==='package.json'&&c.statement.key==='main'&&c.currentness==='CURRENT');
 for(const doc of claims.filter(c=>c.authority==='DOCUMENTARY_EVIDENCE_ONLY'&&c.statement.key==='entrypoint'&&c.currentness==='CURRENT')){
  if(main&&doc.statement.value!==main.statement.value){
   const physical=claims.find(c=>c.scope.path===main.statement.value&&c.authority==='PHYSICAL_OBSERVATION'&&c.currentness==='CURRENT');
   if(physical)items.push({contradictionId:'contradiction:'+sha(Buffer.from(JSON.stringify([doc.claimIdentity,main.claimIdentity,physical.claimIdentity]))),code:'EVIDENCE_CLAIM_MISMATCH',blocking:false,assessment:'DOCUMENTARY_PHYSICAL_DISAGREEMENT',support:[doc.claimIdentity,main.claimIdentity,physical.claimIdentity],summary:'Documentary entrypoint differs from the manifest entrypoint whose bytes were physically observed; runtime behavior remains unverified'});
  }
 }
 // Preserve the existing owner's blocking outcome, without inferring governance from prose.
 const dirty=claims.filter(c=>c.authority==='PHYSICAL_OBSERVATION'&&c.currentness==='STALE');
 if(dirty.length)items.push({contradictionId:'contradiction:'+sha(Buffer.from(JSON.stringify(dirty.map(c=>c.claimIdentity)))),code:'EVIDENCE_CLAIM_MISMATCH',blocking:true,assessment:'SUPPORT_IDENTITY_MISMATCH',support:dirty.map(c=>c.claimIdentity),summary:'Previously observed physical support changed; reconcile supporting evidence before continuation'});
 const blocking=dirty.length>0||upstreamNext?.state==='RECONCILIATION_REQUIRED'||upstreamNext?.state==='BLOCKED'||upstreamNext?.mutation==='RECONCILE';
 const nextStep=dirty.length?{state:'RECONCILIATION_REQUIRED',reason:'Changed physical support invalidates dependent claims',mutatingCommand:null,executionAuthority:false}:upstreamNext;
 return {owner:'EXISTING_CONTRADICTION_RAIL_PHASE4',assessment:items.length?'CONTRADICTION_OBSERVED':'INDETERMINATE',items,blocking:!!blocking,nextStep,resolutionPerformed:false,scope:'Explicit entrypoint documentary/manifest/physical comparison, dirty physical support and unchanged upstream blocking decision; no claim of contradiction absence'};
}
module.exports={artifact,claimsFor,refresh,assessAcquisitionContradictions};
