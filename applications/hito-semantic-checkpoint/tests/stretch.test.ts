import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxClient, Sandbox, Desktop, VolumeClient } from '@solarisdk/sandbox';
import observation from '../src/observation.cjs';
import { hitoSolari, BranchRegistry, sourceFromDirectory, selectedPaths, validateHandoff } from '../src/continuity.ts';
import { envelope, validateEvidence, mergeEvidence, semanticLeaseDecision } from '../src/evidence.ts';
import { route, schedule, observeDesktop, observeBrowser, observeCommand } from '../src/routing.ts';
import { EvidenceCache } from '../src/storage.ts';
import type { Compute } from '../src/types.ts';
// Compilation fails if the real SDK no longer implements the transport contract.
const sdkTypeContract: Compute = null as unknown as SandboxClient;
void sdkTypeContract;
const same = () => sourceFromDirectory(fileURLToPath(new URL('../fixtures/same-state',import.meta.url)));
const changed = () => sourceFromDirectory(fileURLToPath(new URL('../fixtures/changed-state',import.meta.url)));
function fake(options: {gone?: boolean; duplicate?: boolean; createFails?: boolean} = {}) {
  let count=0; const killed: string[]=[];
  const client = {
    async create() {
      count++; if(options.createFails) throw Error('transport');
      const id=options.duplicate?'worker-1':'worker-'+count;
      const root=mkdtempSync(join(tmpdir(),'hito-worker-')); mkdirSync(join(root,'src'));
      let checkpoint: any;
      return {id,async connect(){},close(){rmSync(root,{recursive:true,force:true});},async kill(){killed.push(id);},
        files:{async write(path: string,bytes: string|Uint8Array){
          if(path.endsWith('solari-public-checkpoint.json')) checkpoint=JSON.parse(String(bytes));
          for(const name of selectedPaths) if(path.endsWith('/project/'+name)) writeFileSync(join(root,name),bytes);
        }},
        commands:{async run(_cmd: string,opts: {args:string[]}){
          const mode=opts.args[1];
          const value=mode==='capture'?observation.checkpoint(observation.observe(root)):mode==='takeover'?observation.takeover(root,checkpoint):null;
          return {exitCode:0,stdout:value?JSON.stringify(value):'',stderr:''};
        }} };
    },async get(){return {state:options.gone===false?'running':'gone'};}
  };
  return {client,killed,count:()=>count};
}
async function setup(options = {}) { const f=fake(options); const api=hitoSolari.create(f.client,3); const h=await api.captureHandoff(same()); return {...f,api,h,registry:new BranchRegistry()}; }
test('CONTINUITY_AWARE_SANDBOX: fresh same-state receipt requires termination and parity',async()=>{
  const s=await setup(); const r=await s.api.createContinuitySandbox(same(),s.registry.forkCheckpoint(s.h,'same'));
  assert.notEqual(r.workerId,s.h.senderId); assert.equal(r.termination.terminated,true); assert.equal(r.takeover.changed.length,0); assert.equal(r.authority.executionAuthority,false); assert.equal(s.killed.length,2);
});
test('SAFE_HANDOFF: source hash, sender, termination and unknowns survive',async()=>{
  const s=await setup(); assert.equal(s.h.checkpointId,s.h.checkpoint.sha256); assert.equal(s.h.termination.id,s.h.senderId);
  const r=await s.api.resumeFromHandoff(changed(),s.registry.forkCheckpoint(s.h,'changed'));
  assert.equal(r.takeover.changed.length,1); assert.deepEqual(r.takeover.unknowns,s.h.checkpoint.payload.observation.unknowns);
});
test('MULTI_WORKER_IDENTITY / SEMANTIC_FORK: two independent branches never mutate parent',async()=>{
  const s=await setup(); const before=JSON.stringify(s.h);
  const rs=await s.api.multiWorker([{source:same(),branch:s.registry.forkCheckpoint(s.h,'B')},{source:changed(),branch:s.registry.forkCheckpoint(s.h,'C')}]);
  assert.notEqual(rs[0].workerId,rs[1].workerId); assert.equal(rs[0].takeover.changed.length,0); assert.equal(rs[1].takeover.changed.length,1); assert.equal(JSON.stringify(s.h),before);
});
for(const [name,mutate] of [
  ['corrupted checkpoint',(h:any)=>{h.checkpoint={};}],
  ['tampered checkpoint hash',(h:any)=>{h.checkpoint.sha256='0'.repeat(64);}],
  ['false authority',(h:any)=>{h.authority.executionAuthority=true;}],
  ['wrong termination identity',(h:any)=>{h.termination.id='other';}],
  ['unconfirmed termination',(h:any)=>{h.termination.terminated=false;}],
] as const) test('ADVERSARIAL: '+name,async()=>{const s=await setup(); mutate(s.h); assert.throws(()=>validateHandoff(s.h));});
test('ADVERSARIAL: missing selected source rejected before dispatch',async()=>{const f=fake();const src:any=same();delete src['README.md'];await assert.rejects(hitoSolari.create(f.client,1).captureHandoff(src));assert.equal(f.count(),0);});
test('ADVERSARIAL: oversized source rejected before dispatch',async()=>{const f=fake();const src=same();src['README.md']=Buffer.alloc(65537);await assert.rejects(hitoSolari.create(f.client,1).captureHandoff(src));assert.equal(f.count(),0);});
test('ADVERSARIAL: symlink selected root rejected',()=>{const dir=mkdtempSync(join(tmpdir(),'hito-link-'));try{const target=join(dir,'target');mkdirSync(target);const link=join(dir,'link');symlinkSync(target,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>sourceFromDirectory(link),/LINK_EXCLUDED/);}finally{rmSync(dir,{recursive:true,force:true});}});
test('ADVERSARIAL: invalid branch parent rejected without creation',async()=>{const s=await setup();const b=s.registry.forkCheckpoint(s.h,'B');b.parentCheckpointId='wrong';await assert.rejects(s.api.resumeFromHandoff(same(),b));assert.equal(s.count(),1);});
test('ADVERSARIAL: duplicate branch ID rejected',async()=>{const s=await setup();s.registry.forkCheckpoint(s.h,'B');assert.throws(()=>s.registry.forkCheckpoint(s.h,'B'));});
test('ADVERSARIAL: create budget exceeded never dispatches',async()=>{const f=fake();const api=hitoSolari.create(f.client,1);await api.captureHandoff(same());await assert.rejects(api.captureHandoff(same()),/BUDGET/);assert.equal(f.count(),1);});
test('ADVERSARIAL: uncertain destruction blocks all later workers',async()=>{const f=fake({gone:false});const api=hitoSolari.create(f.client,3);await assert.rejects(api.captureHandoff(same()),/TERMINATION/);await assert.rejects(api.captureHandoff(same()),/CLEANUP/);assert.equal(f.count(),1);});
test('ADVERSARIAL: unknown create outcome consumes budget and stops',async()=>{const f=fake({createFails:true});const api=hitoSolari.create(f.client,3);await assert.rejects(api.captureHandoff(same()),/UNKNOWN/);await assert.rejects(api.captureHandoff(same()));assert.equal(f.count(),1);});
test('ADVERSARIAL: reused sandbox identity is rejected',async()=>{const s=await setup({duplicate:true});await assert.rejects(s.api.resumeFromHandoff(same(),s.registry.forkCheckpoint(s.h,'B')),/FRESH/);});
const ev=(workerId:string,bytes='same')=>envelope({primitiveType:'SANDBOX',workerId,sourceIdentity:'file:F',observationType:'FILE_BYTES',observedAt:'2026-09-10T00:00:00Z'},Buffer.from(bytes));
const branch=(branchId:string,evidence=[ev(branchId)])=>({parentCheckpointId:'a'.repeat(64),branchId,evidence});
test('EVIDENCE_MERGE: safe union retains workers and no currentness promotion',()=>{const r=mergeEvidence(branch('B'),branch('C'));assert.equal(r.status,'SAFE_UNION');assert.equal(r.evidence.length,2);assert.equal(r.authority.canonicalAuthority,false);});
test('ADVERSARIAL: two branches disagree requires reobservation',()=>assert.equal(mergeEvidence(branch('B'),branch('C',[ev('C','changed')])).status,'CONFLICT_REQUIRES_REOBSERVATION'));
test('ADVERSARIAL: one branch missing evidence remains unknown',()=>assert.equal(mergeEvidence(branch('B'),branch('C',[])).status,'UNKNOWN'));
test('ADVERSARIAL: merge unrelated parents refused',()=>assert.equal(mergeEvidence(branch('B'),{...branch('C'),parentCheckpointId:'b'.repeat(64)}).status,'NO_SAFE_MERGE'));
test('ADVERSARIAL: authority escalation in evidence refused',()=>{const e:any=ev('C');e.authority.executionAuthority=true;assert.equal(mergeEvidence(branch('B'),branch('C',[e])).status,'NO_SAFE_MERGE');});
test('SEMANTIC_LEASE_DECISION: existing currentness owns validity',()=>assert.equal(semanticLeaseDecision.verdict,'KILL'));
test('SCHEDULER_ROUTING: exact routes and unsupported requirement',()=>{assert.equal(route('SOURCE_OR_COMMAND_EXECUTION'),'SANDBOX');assert.equal(route('GUI_DESKTOP_OBSERVATION'),'DESKTOP');assert.equal(route('WEB_INTERACTION_OR_DOM'),'BROWSER');assert.equal(route('invented'),'UNSUPPORTED');});
test('SCHEDULER_ROUTING: one attempt, missing adapter, and failure stay explicit',async()=>{let calls=0;assert.equal((await schedule('invented',{})).status,'UNSUPPORTED');assert.equal((await schedule('WEB_INTERACTION_OR_DOM',{})).status,'UNSUPPORTED');assert.equal((await schedule('GUI_DESKTOP_OBSERVATION',{DESKTOP:async()=>{calls++;throw Error('fail');}})).status,'UNKNOWN');assert.equal(calls,1);});
test('CROSS_PRIMITIVE_EVIDENCE: DOM is not source or screenshot evidence',()=>{assert.throws(()=>envelope({primitiveType:'BROWSER',workerId:'b',sourceIdentity:'page',observationType:'FILE_BYTES',observedAt:'2026-09-10'},Buffer.from('x')));const e=ev('B');assert.deepEqual(validateEvidence(e,Buffer.from('same')),e);assert.throws(()=>validateEvidence(e,Buffer.from('other')));});
test('CROSS_PRIMITIVE_EVIDENCE: actual adapter contracts retain distinct semantics',async()=>{
  const d=await observeDesktop({id:'d',screenshot:async()=>Buffer.from('png')} as any);assert.equal(d.evidence.observationType,'SCREENSHOT');
  const b=await observeBrowser({content:async()=>'<p>fixture</p>'},'b','fixture');assert.equal(b.evidence.observationType,'DOM');
  const c=await observeCommand({id:'s',commands:{run:async()=>({exitCode:1,stdout:'',stderr:'fixture'})}} as any,'false',[]);assert.equal(c.observationType,'COMMAND_RESULT');
});
test('PERSISTENT_EVIDENCE_BOUNDARY: digest-addressed cache verifies read and never claims durability',async()=>{const files=new Map<string,Uint8Array>();const cache=new EvidenceCache({files:{write:async(p:string,b:Uint8Array)=>{files.set(p,Buffer.from(b));},read:async(p:string)=>files.get(p)!}} as any);const ref=await cache.put(Buffer.from('artifact'));assert.equal(ref.persistence,'UNVERIFIED');assert.equal(Buffer.from(await cache.get(ref)).toString(),'artifact');files.set('/evidence/'+ref.sha256,Buffer.from('tampered'));await assert.rejects(cache.get(ref),/INTEGRITY/);await assert.rejects(cache.get({sha256:'../escape',bytes:1}));});
test('CONTEXTUAL_API: namespace belongs to application and SDK methods exist offline',()=>{assert.equal(typeof hitoSolari.create,'function');for(const name of ['create','get','createDesktop'])assert.equal(typeof (SandboxClient.prototype as any)[name],'function');for(const name of ['connect','kill','snapshot','previewUrl'])assert.equal(typeof (Sandbox.prototype as any)[name],'function');assert.equal(typeof Desktop.prototype.screenshot,'function');assert.equal(typeof VolumeClient.prototype.create,'function');});
test('PUBLICATION_BOUNDARY / SECRET_BOUNDARY / NO_MODEL_PROVIDER: dependency and runtime surface',()=>{const p=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));assert.deepEqual(Object.keys(p.dependencies).sort(),['@solarisdk/browser','@solarisdk/sandbox']);for(const f of ['continuity.ts','evidence.ts','routing.ts','storage.ts']){const s=readFileSync(new URL('../src/'+f,import.meta.url),'utf8');assert.doesNotMatch(s,/process\.env|https?:\/\//);}});
test('SOLARI_API_TRUTH: integration calls stay inside reviewed real SDK members',()=>{
  const rules: Record<string,string[]> = {
    'continuity.ts':['client.create','sandbox.connect','sandbox.commands.run','sandbox.files.write','sandbox.close'],
    'routing.ts':['sandbox.commands.run','desktop.screenshot','page.content'],
    'storage.ts':['worker.files.write','worker.files.read'],
  };
  for(const [file,allowed] of Object.entries(rules)) {
    const text=readFileSync(new URL('../src/'+file,import.meta.url),'utf8');
    const calls=[...text.matchAll(/\b(?:this\.)?((?:client|sandbox|desktop|page|worker)(?:\.[a-zA-Z]+)+)\(/g)].map(m=>m[1]);
    assert(calls.length>0);for(const call of calls)assert(allowed.includes(call),'Unreviewed SDK method: '+call);
  }
  const declarations=readFileSync(new URL('../node_modules/@solarisdk/core/dist/handle.d.ts',import.meta.url),'utf8');
  for(const name of ['run','write','read'])assert.match(declarations,new RegExp('\\b'+name+':'));
});
test('SECRET_BOUNDARY: remote error text does not escape continuity wrapper',async()=>{
  const f=fake();const original=f.client.create;
  f.client.create=async()=>{const worker=await original();worker.connect=async()=>{throw Error('fixture-sensitive-remote-detail');};return worker;};
  await assert.rejects(hitoSolari.create(f.client,1).captureHandoff(same()),error=>error instanceof Error && error.message==='CONTINUITY_OPERATION_FAILED');
  assert.equal(f.killed.length,1);
});
