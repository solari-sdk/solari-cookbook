import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Solari,BrowserSession} from '@solarisdk/browser';
import {SandboxClient,Desktop,VolumeClient} from '@solarisdk/sandbox';
import {StretchHarness,deterministicHtml} from '../src/stretch-harness.ts';
import {ResourceLedger,ceilings,guardedComputeFetch,officialClients} from '../src/stretch-resources.ts';
import {sourceFromDirectory} from '../src/continuity.ts';
import {envelope,validateEvidence,reconcileEvidence} from '../src/evidence.ts';
import {route,schedule} from '../src/routing.ts';
import observation from '../src/observation.cjs';
import publication from '../src/publication-scan.cjs';
import {attemptStore} from '../src/stretch-entry.ts';
const source=(name='same-state')=>sourceFromDirectory(fileURLToPath(new URL('../fixtures/'+name,import.meta.url)));
function apparatus(failure='') {
  const log:string[]=[];let count=0;const volume=new Map<string,Uint8Array>();const snapshots:any[]=[];
  const deps:any={compute:{
    volumes:{async create(){log.push('V:create');if(failure==='volume501')throw {status:501};return {volumeId:'V1'};},async delete(){log.push('V:delete');},async get(){throw {status:404};}},
    async create(options:any){count++;const id='S'+count;log.push(id+':create');if(failure==='sandboxUnknown')throw Error('uncertain');if(failure==='mount501')throw {status:501};
      if(failure!=='volume501')assert.deepEqual(options.volumes,[{volumeId:'V1',path:'/evidence'}]);
      const root=mkdtempSync(join(tmpdir(),'r2-worker-'));mkdirSync(join(root,'src'));let checkpoint:any;
      return {id,async connect(){},close(){rmSync(root,{recursive:true,force:true});},async kill(){log.push(id+':kill');},
        files:{async write(p:string,b:Uint8Array|string){if(p.startsWith('/evidence/')){volume.set(p,Buffer.from(b));log.push(id+':write-volume');return;}
          if(p.endsWith('solari-public-checkpoint.json')){checkpoint=JSON.parse(String(b));return;}
          const marker='/project/';if(p.includes(marker))writeFileSync(join(root,p.split(marker)[1]),b);
        },async read(p:string){log.push(id+':read-volume');return failure==='tamper'?Buffer.from('wrong'):volume.get(p)!;}},
        commands:{async run(cmd:string,opts:any){const mode=opts.args[1];const value=mode==='capture'?observation.checkpoint(observation.observe(root)):mode==='takeover'?observation.takeover(root,checkpoint):null;return {exitCode:0,stdout:value?JSON.stringify(value):'',stderr:''};}}
      };
    },async get(id:string){return {state:failure==='cleanup'?'running':'gone'};},
    async createDesktop(){log.push('D:create');return {id:'D1',async health(){return {ready:true,display:true,vnc:true};},async connect(){},close(){},async kill(){log.push('D:kill');},display:{async set(){},async size(){return {w:800,h:600};}},commands:{async run(){return {exitCode:0};}},async screenshot(){log.push('D:screenshot');return Buffer.from('deterministic-png-fixture');}};}
  },browser:{async launch(opts:any){log.push('B:create');assert.deepEqual(opts,{retries:0,probe:false});if(failure==='browser')throw Error('launch');let html='';return {id:'B1',async newPage(){return {async setContent(value:string){html=value;},async title(){return 'HITO evidence fixture';},async content(){return html;}};},async close(){log.push('B:release');if(failure==='browserCleanup')throw Error('unconfirmed');}};},async close(){log.push('B:client-close');}}};
  return {deps,log,snapshots,options:{qualification:'CONTROLLED_STATIC' as const,claimAttempt(){log.push('claim');},persist(records:any){snapshots.push(structuredClone(records));}}};
}
async function run(failure=''){const a=apparatus(failure);const report=await new StretchHarness().run(a.deps,source(),source('changed-state'),a.options);return {...a,report};}
test('OFFICIAL_BROWSER_PACKAGE_PRESENT',()=>{const p=JSON.parse(readFileSync(new URL('../node_modules/@solarisdk/browser/package.json',import.meta.url),'utf8'));assert.equal(p.version,'0.1.4');assert.equal(p.license,'Apache-2.0');});
test('BROWSER_API_IS_REAL_SOLARI_API',()=>{assert.equal(typeof Solari.prototype.launch,'function');assert.equal(typeof BrowserSession.prototype.newPage,'function');assert.equal(typeof BrowserSession.prototype.close,'function');});
test('DESKTOP_API_IS_REAL_SOLARI_API',()=>{assert.equal(typeof SandboxClient.prototype.createDesktop,'function');assert.equal(typeof Desktop.prototype.screenshot,'function');});
test('VOLUME_API_IS_REAL_SOLARI_API',()=>{for(const m of ['create','get','list','delete'])assert.equal(typeof (VolumeClient.prototype as any)[m],'function');});
test('ONLY_SOLARI_API_KEY_REQUIRED',()=>assert.equal(readFileSync(new URL('../.env.example',import.meta.url),'utf8'),'SOLARI_API_KEY=\n'));
test('ONE_KEY_CREDENTIAL_BOUNDARY',async()=>{assert.throws(()=>officialClients(''));const clients=officialClients('static-fixture');assert(clients.compute instanceof SandboxClient);assert(clients.browser instanceof Solari);await clients.browser.close();});
for(const [requirement,primitive] of Object.entries({SOURCE_OR_COMMAND_EXECUTION:'SANDBOX',GUI_DESKTOP_OBSERVATION:'DESKTOP',WEB_INTERACTION_OR_DOM:'BROWSER',PERSISTENT_ARTIFACT_RETRIEVAL:'VOLUME'}))test('SCHEDULER_ROUTES_'+primitive,()=>assert.equal(route(requirement),primitive));
test('UNSUPPORTED_REQUIREMENT_FAILS_CLOSED',async()=>assert.equal((await schedule('NO_ROUTE',{})).status,'UNSUPPORTED'));
test('CROSS_PRIMITIVE_ENVELOPE_DOES_NOT_EQUALIZE_SEMANTICS',()=>assert.throws(()=>envelope({primitiveType:'VOLUME',workerId:'s',resourceId:'v',sourceIdentity:'x',observationType:'DOM',observedAt:'2026-09-10'},Buffer.from('x'))));
for(const [primitive,kind] of [['BROWSER','DOM'],['DESKTOP','SCREENSHOT']] as const)test(primitive+'_EVIDENCE_NO_AUTHORITY_ESCALATION',()=>{const e=envelope({primitiveType:primitive,workerId:'w',sourceIdentity:'fixture',observationType:kind,observedAt:'2026-09-10'},Buffer.from('x'));(e.authority as any).executionAuthority=true;assert.throws(()=>validateEvidence(e,Buffer.from('x')));});
test('VOLUME_PERSISTENCE_NO_CURRENTNESS_ESCALATION',async()=>{const {report}=await run();const e=report.evidence.find(e=>e.primitiveType==='VOLUME')!;assert.equal(e.currentness,'NOT_ESTABLISHED');assert.equal(e.resourceId,'V1');assert.equal(e.workerId,'S2');assert.equal(e.authority.canonicalAuthority,false);});
test('FORK_PARENT_IDENTITY_PRESERVED',async()=>{const {report}=await run();const [parent,b,c]=report.receipts as any[];assert.equal(b.parentCheckpointId,parent.checkpointId);assert.equal(c.parentCheckpointId,parent.checkpointId);});
test('WORKERS_HAVE_DISTINCT_IDENTITIES',async()=>{const {report}=await run();assert.equal(new Set(report.resources.filter(r=>r.kind==='SANDBOX').map(r=>r.id)).size,3);});
test('DIVERGENT_WORKERS_DO_NOT_AUTO_MERGE',async()=>assert.equal(((await run()).report.reconciliation as any).status,'CONFLICT_REQUIRES_REOBSERVATION'));
test('EVIDENCE_RECONCILIATION_CAN_REFUSE',()=>assert.equal(reconcileEvidence({parentCheckpointId:'x',branchId:'B',evidence:[]},{parentCheckpointId:'y',branchId:'C',evidence:[]}).status,'NO_SAFE_MERGE'));
for(const [kind,name] of [['SANDBOX','THREE_SANDBOX_MAX'],['DESKTOP','ONE_DESKTOP_MAX'],['BROWSER','ONE_BROWSER_MAX'],['VOLUME','ONE_VOLUME_MAX']] as const)test(name,()=>{const l=new ResourceLedger(()=>{});for(let i=0;i<ceilings[kind];i++)l.reserve(kind);assert.throws(()=>l.reserve(kind));});
test('NO_SNAPSHOT',async()=>{const l=new ResourceLedger(()=>{});assert.throws(()=>l.reserve('SNAPSHOT'));let calls=0;const fetcher=guardedComputeFetch(async()=>{calls++;return new Response();});await assert.rejects(fetcher('https://api.getsolari.com/sandboxes/s/snapshots',{method:'POST'}));assert.equal(calls,0);});
test('NO_EXTERNAL_MODEL',()=>{const p=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));assert.deepEqual(Object.keys(p.dependencies).sort(),['@solarisdk/browser','@solarisdk/sandbox']);});
test('NO_INVENTED_NATIVE_SOLARI_API',()=>{const source=readFileSync(new URL('../src/stretch-harness.ts',import.meta.url),'utf8');assert.match(source,/deps\.browser\.launch\(\{retries:0,probe:false\}\)/);assert.doesNotMatch(source,/solari\.sandbox|continuityCheckpoint:/);const d=readFileSync(new URL('../node_modules/patchright-core/types/types.d.ts',import.meta.url),'utf8');assert.match(d,/setContent\(html: string/);assert.match(d,/title\(\): Promise<string>/);});
test('PUBLICATION_SECRET_SCAN_PASS',()=>assert.equal(publication.scan(new URL('../',import.meta.url)).status,'PASS'));
test('PRIVATE_PATH_SCAN_PASS',()=>assert.equal(publication.scan(new URL('../',import.meta.url)).findings.filter((f:any)=>f.category==='PRIVATE_ABSOLUTE_PATH').length,0));
test('INTEGRATED_TOPOLOGY_AND_CLEANUP: volume producer gone before fresh retrieval; all routes; static never live',async()=>{
  const {report,log,snapshots}=await run();assert.equal(report.resources.length,6);assert(report.resources.every(r=>r.state==='TERMINAL'));
  assert(log.indexOf('S1:kill')<log.indexOf('S2:read-volume'));assert(log.indexOf('S3:kill')<log.indexOf('V:delete'));
  assert(report.evidence.some(e=>e.primitiveType==='BROWSER'));assert(report.evidence.some(e=>e.primitiveType==='DESKTOP'));
  assert(Object.values(report.cases).every(v=>v==='PARTIAL'));assert.equal(report.qualification,'CONTROLLED_STATIC');
  assert(snapshots.some(s=>s.some((r:any)=>r.state==='DISPATCHING')));
  assert.equal(report.volumeReference?.producerResourceId,'S1');
});
test('VOLUME_501_IS_RUNTIME_BLOCK_ONLY_NO_REPLACEMENT',async()=>{const {report,log}=await run('volume501');assert.equal(report.cases.S3,'BLOCKED_PLATFORM_RUNTIME');assert.equal(log.filter(x=>x==='V:create').length,1);assert.equal(report.resources.filter(r=>r.kind==='SANDBOX').length,3);});
test('UNKNOWN_SANDBOX_CREATION_STOPS_REPLACEMENTS',async()=>{const {report,log}=await run('sandboxUnknown');assert.equal(log.filter(x=>/^S\d:create$/.test(x)).length,1);assert.equal(report.cases.S1,'FAIL');assert.equal(report.cases.D1,'NOT_EXECUTED');assert(report.resources.some(r=>r.state==='UNKNOWN'));});
test('UNCONFIRMED_CLEANUP_STOPS_NEW_RESOURCES',async()=>{const {report,log}=await run('cleanup');assert.equal(log.filter(x=>/^S\d:create$/.test(x)).length,1);assert.equal(report.cases.S1,'FAIL');assert(!log.includes('D:create'));});
test('BROWSER_FAILURE_HAS_NO_REPLACEMENT_OR_FALSE_TERMINATION',async()=>{const {report,log}=await run('browser');assert.equal(log.filter(x=>x==='B:create').length,1);assert.equal(report.cases.B1,'FAIL');assert.equal(report.resources.find(r=>r.kind==='BROWSER')?.state,'UNKNOWN');});
test('BROWSER_CLEANUP_FAILURE_REMAINS_NONTERMINAL',async()=>{const {report}=await run('browserCleanup');assert.equal(report.cases.B1,'FAIL');assert.equal(report.resources.find(r=>r.kind==='BROWSER')?.state,'CREATED');});
test('TAMPERED_VOLUME_RETRIEVAL_REJECTED',async()=>assert.equal((await run('tamper')).report.cases.S1,'FAIL'));
test('RESOURCE_HTTP_RETRY_GUARD',async()=>{let calls=0;const f=guardedComputeFetch(async()=>{calls++;return new Response('{}');});const opts={method:'POST',headers:{'Idempotency-Key':'one'},body:'{}'};await f('https://api.getsolari.com/sandboxes',opts);await assert.rejects(f('https://api.getsolari.com/sandboxes',opts));assert.equal(calls,1);});
test('ONE_SHOT_HARNESS_AND_FAILED_ATTEMPT_LOCK',async()=>{const a=apparatus();const h=new StretchHarness();await h.run(a.deps,source(),source('changed-state'),a.options);await assert.rejects(h.run(a.deps,source(),source('changed-state'),a.options),/ONE_RUN/);const b=apparatus();await assert.rejects(new StretchHarness().run(b.deps,source(),source('changed-state'),{...b.options,claimAttempt(){throw Error('lock');}}));assert.equal(b.log.length,0);});
test('DURABLE_ATTEMPT_STORE: exclusive claim and ledger roundtrip without live dispatch',()=>{const dir=mkdtempSync(join(tmpdir(),'r2-attempt-fixture-'));try{const store=attemptStore(dir);store.claimAttempt();assert.throws(()=>store.claimAttempt());store.persist([{kind:'BROWSER',attempt:1,state:'UNKNOWN'}]);assert.equal(JSON.parse(readFileSync(join(dir,'resource-ledger.json'),'utf8'))[0].state,'UNKNOWN');}finally{rmSync(dir,{recursive:true,force:true});}});
test('LEDGER_PERSISTENCE_FAILURE_BLOCKS_CREATE_BEFORE_DISPATCH',()=>{const ledger=new ResourceLedger(()=>{throw Error('disk');});assert.throws(()=>ledger.reserve('SANDBOX'),/PERSIST/);assert.throws(()=>ledger.reserve('SANDBOX'),/STOP/);});


test('OPTIONAL_VOLUME_DISABLED_FULL_TOPOLOGY_WITH_ZERO_VOLUME_CALLS',async()=>{
  const a=apparatus('volume501');
  a.deps.compute.volumes=new Proxy({}, {get(){throw Error('VOLUME_ACCESS_FORBIDDEN');}});
  const r=await new StretchHarness().run(a.deps,source(),source('changed-state'),{...a.options,volume:'disabled'});
  assert.equal(r.resources.length,5);assert(r.resources.every(x=>x.state==='TERMINAL'));
  assert.equal(r.cases.S1,'PARTIAL');assert.equal(r.cases.S2,'PARTIAL');assert.equal(r.cases.D1,'PARTIAL');assert.equal(r.cases.B1,'PARTIAL');assert.equal(r.cases.R1,'PARTIAL');
  assert.equal(r.cases.S3,'NOT_EXECUTED');assert(!r.evidence.some(e=>e.primitiveType==='VOLUME'));
  assert.equal(r.routing?.find(x=>x.primitive==='VOLUME')?.execution,'DISABLED_NO_DISPATCH');
  assert.equal(r.routing?.find(x=>x.primitive==='UNSUPPORTED')?.execution,'UNSUPPORTED');
});
test('DISABLED_VOLUME_HTTP_BOUNDARY_REJECTS_ALL_VOLUME_METHODS',async()=>{
  let calls=0;const f=guardedComputeFetch(async()=>{calls++;return new Response('{}');},'disabled');
  for(const method of ['GET','POST','DELETE'])await assert.rejects(f('https://api.getsolari.com/volumes',{method}),/VOLUME_DISABLED/);
  assert.equal(calls,0);
});
