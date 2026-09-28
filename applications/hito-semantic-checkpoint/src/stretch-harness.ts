/** One coordinated, explicit run. No CLI entrypoint or automatic live dispatch. */
import type { SandboxClient, Sandbox as NativeSandbox } from '@solarisdk/sandbox';
import type { Solari } from '@solarisdk/browser';
import { BranchRegistry, ContinuitySandbox, digest } from './continuity.ts';
import type { Source } from './continuity.ts';
import type { Compute, Sandbox } from './types.ts';
import { envelope, reconcileEvidence } from './evidence.ts';
import type { EvidenceEnvelope } from './evidence.ts';
import { observeDesktop, observeBrowser, schedule, route as selectRoute } from './routing.ts';
import { EvidenceCache } from './storage.ts';
import { terminate } from './solari.ts';
import { ResourceLedger } from './stretch-resources.ts';
import type { ResourceRecord } from './stretch-resources.ts';

export const deterministicHtml='<!doctype html><title>HITO evidence fixture</title><h1>Bounded observation</h1><p id="state">ready</p>';
const artifact=Buffer.from('HITO deterministic persistent evidence\n'.repeat(256));
export type LiveClass='PROVEN_LIVE'|'PARTIAL'|'BLOCKED_PLATFORM_RUNTIME'|'UNSUPPORTED'|'FAIL'|'NOT_EXECUTED';
export interface RunReport {
  qualification:'LIVE'|'CONTROLLED_STATIC';
  cases:Record<'S1'|'S2'|'S3'|'D1'|'B1'|'R1',LiveClass>;
  routing?:{requirement:string;primitive:string;execution:string}[];
  resources:ResourceRecord[]; evidence:EvidenceEnvelope[];
  artifacts:{sha256:string; bytes:Uint8Array}[];
  receipts:unknown[]; reconciliation?:unknown;
  failures:{phase:string;code:string;status?:number}[];
  volumeReference?:{volumeId:string;path:string;sha256:string;producerResourceId:string;producerEvidenceId:string};
}
export interface HarnessDependencies {
  compute:Pick<SandboxClient,'create'|'get'|'createDesktop'|'volumes'>;
  browser:Pick<Solari,'launch'|'close'>;
}
/** Caller must persist records synchronously before dispatch. For live mode,
 * claimAttempt must atomically create a new exclusive attempt lock or throw. */
export class StretchHarness {
  private used=false;
  async run(deps:HarnessDependencies,source:Source,changed:Source,options:{
    qualification:'LIVE'|'CONTROLLED_STATIC'; claimAttempt:()=>void;
    volume?:'enabled'|'disabled';
    persist:(records:ResourceRecord[])=>void;
  }):Promise<RunReport> {
    if(this.used)throw Error('ONE_RUN_ONLY');this.used=true;
    options.claimAttempt();
    const ledger=new ResourceLedger(options.persist);
    const report:RunReport={qualification:options.qualification,cases:{S1:'NOT_EXECUTED',S2:'NOT_EXECUTED',S3:'NOT_EXECUTED',D1:'NOT_EXECUTED',B1:'NOT_EXECUTED',R1:'NOT_EXECUTED'},resources:[],evidence:[],artifacts:[],receipts:[],failures:[]};
    const success:LiveClass=options.qualification==='LIVE'?'PROVEN_LIVE':'PARTIAL';
    let volumeId:string|undefined;
    let reference:Awaited<ReturnType<EvidenceCache['put']>>|undefined;
    let producerGone=false;
    const routed=new Set<string>();
    const add=(e:EvidenceEnvelope,bytes:Uint8Array)=>{report.evidence.push(e);report.artifacts.push({sha256:digest(bytes),bytes});};
    const route=async(kind:string,fn:()=>Promise<unknown>)=>{
      const primitive=kind==='SOURCE_OR_COMMAND_EXECUTION'?'SANDBOX':kind==='GUI_DESKTOP_OBSERVATION'?'DESKTOP':kind==='WEB_INTERACTION_OR_DOM'?'BROWSER':'VOLUME';
      const result=await schedule(kind,{[primitive]:fn});
      if(result.status!=='OBSERVED_NOT_REQUIREMENT_PROVEN')throw Error('ROUTE_FAILED');
      routed.add(primitive);return result;
    };
    const killAck=new Set<string>();
    const compute:Compute={
      create:async opts=>{
        const record=ledger.reserve('SANDBOX');
        let worker:NativeSandbox;
        try {worker=await deps.compute.create({...opts,...(volumeId?{volumes:[{volumeId,path:'/evidence'}]}:{})});}
        catch(error) {report.failures.push({phase:'SANDBOX_CREATE',code:'OUTCOME_UNKNOWN',status:status(error)});if(volumeId && status(error)===501)report.cases.S3='BLOCKED_PLATFORM_RUNTIME';ledger.rejected(record,false);throw Error('SANDBOX_CREATE_UNKNOWN');}
        ledger.created(record,worker.id);
        return {id:worker.id,files:worker.files,commands:worker.commands,
          connect:async()=>{ledger.workAllowed();await worker.connect();},
          close:()=>worker.close(),kill:async()=>{await worker.kill();killAck.add(worker.id);}};
      },
      get:async id=>{
        try {const state=await deps.compute.get(id);if(state.state==='gone'&&killAck.has(id))ledger.terminal('SANDBOX',id,'KILL_ACK_AND_GET_GONE');return state;}
        catch(error){if(status(error)===404 && killAck.has(id))ledger.terminal('SANDBOX',id,'KILL_ACK_AND_STRUCTURED_404');throw error;}
      },
    };
    try {
      if(options.volume!=='disabled') {
      const record=ledger.reserve('VOLUME');
      try {const volume=await deps.compute.volumes.create({name:'hito-stretch-evidence'});volumeId=volume.volumeId;ledger.created(record,volumeId);}
      catch(error){const unsupported=status(error)===501;report.failures.push({phase:'VOLUME_CREATE',code:unsupported?'UNSUPPORTED':'OUTCOME_UNKNOWN',status:status(error)});ledger.rejected(record,unsupported);report.cases.S3=unsupported?'BLOCKED_PLATFORM_RUNTIME':'FAIL';if(!unsupported)throw Error('VOLUME_CREATE_UNKNOWN');}
      }
      const continuity=new ContinuitySandbox(compute,3,async(worker:Sandbox,context)=>{
        // This hook executes inside the same worker lifecycle, before kill.
        if(context.phase==='takeover') {
          const selected=context.observation.current.artifacts.find((a:any)=>a.path==='src/index.js');
          if(selected?.state!=='OBSERVED')throw Error('SELECTED_SUPPORT_MISSING');
          const bytes=Buffer.from(selected.content);
          await route('SOURCE_OR_COMMAND_EXECUTION',async()=>{
            const e=envelope({primitiveType:'SANDBOX',resourceId:worker.id,workerId:worker.id,parentCheckpointId:context.checkpointId,sourceIdentity:'src/index.js',observationType:'FILE_BYTES',observedAt:new Date().toISOString()},bytes);add(e,bytes);return e;
          });
        }
        if(!volumeId)return;
        if(!worker.files.read)throw Error('FILE_READ_UNAVAILABLE');
        const cache=new EvidenceCache({files:{write:worker.files.write,read:worker.files.read}});
        try { if(context.phase==='capture') {
          reference=await cache.put(artifact);
          const e=envelope({primitiveType:'SANDBOX',resourceId:worker.id,workerId:worker.id,parentCheckpointId:context.checkpointId,sourceIdentity:'persistent-artifact-producer',observationType:'FILE_BYTES',observedAt:new Date().toISOString()},artifact);
          add(e,artifact);
          report.volumeReference={volumeId,path:'/evidence/'+reference.sha256,sha256:reference.sha256,producerResourceId:worker.id,producerEvidenceId:e.evidenceId};
        }else if(reference && report.cases.S3==='NOT_EXECUTED') {
          if(!producerGone || report.volumeReference?.producerResourceId===worker.id)throw Error('FRESH_RETRIEVER_REQUIRED');
          await route('PERSISTENT_ARTIFACT_RETRIEVAL',async()=>{
            const bytes=await cache.get(reference!);
            const e=envelope({primitiveType:'VOLUME',resourceId:volumeId!,workerId:worker.id,parentCheckpointId:context.checkpointId,sourceIdentity:report.volumeReference!.path,observationType:'ARTIFACT_RETRIEVAL',observedAt:new Date().toISOString()},bytes);add(e,bytes);return e;
          });
          report.cases.S3=success;
        }} catch(error) {
          const unsupported=status(error)===501;
          report.cases.S3=unsupported?'BLOCKED_PLATFORM_RUNTIME':'FAIL';
          report.failures.push({phase:'VOLUME_IO',code:unsupported?'UNSUPPORTED':'ARTIFACT_VERIFICATION_FAILED',status:status(error)});
          if(!unsupported)throw Error('VOLUME_IO_FAILED');
        }
      });
      const parent=await continuity.captureHandoff(source);producerGone=true;report.receipts.push(parent);
      const branches=new BranchRegistry();
      const b=await continuity.resumeFromHandoff(source,branches.forkCheckpoint(parent,'B'));report.receipts.push(b);
      const c=await continuity.resumeFromHandoff(changed,branches.forkCheckpoint(parent,'C'));report.receipts.push(c);
      if(new Set([parent.senderId,b.workerId,c.workerId]).size!==3 || b.takeover.changed.length!==0 || c.takeover.changed.length===0)throw Error('TOPOLOGY_OR_DIVERGENCE');
      report.cases.S1=success;
      const branch=(id:string,workerId:string)=>({parentCheckpointId:parent.checkpointId,branchId:id,evidence:report.evidence.filter(e=>e.workerId===workerId && e.primitiveType==='SANDBOX' && e.sourceIdentity==='src/index.js')});
      report.reconciliation=reconcileEvidence(branch('B',b.workerId),branch('C',c.workerId));
      report.cases.S2=(report.reconciliation as {status:string}).status==='CONFLICT_REQUIRES_REOBSERVATION'?success:'FAIL';
    } catch {report.cases.S1='FAIL';if(ledger.snapshot().some(r=>r.kind==='SANDBOX'&&r.state!=='TERMINAL'&&r.state!=='REJECTED'))ledger.uncertain();}
    finally {
      if(volumeId) {
        try {
          if(ledger.snapshot().some(r=>r.kind==='SANDBOX'&&r.state!=='TERMINAL'&&r.state!=='REJECTED'))throw Error('WORKER_CLEANUP_UNKNOWN');
          await deps.compute.volumes.delete(volumeId);
          try {await deps.compute.volumes.get(volumeId);throw Error('VOLUME_STILL_PRESENT');}
          catch(error){if(status(error)!==404)throw error;}
          ledger.terminal('VOLUME',volumeId,'DELETE_ACK_AND_STRUCTURED_404');
        }catch{if(report.cases.S3!=='BLOCKED_PLATFORM_RUNTIME')report.cases.S3='FAIL';report.failures.push({phase:'VOLUME_CLEANUP',code:'CLEANUP_UNCONFIRMED'});ledger.uncertain();}
      }
    }
    try {
      const record=ledger.reserve('DESKTOP');
      let desktop;
      try {desktop=await deps.compute.createDesktop({template:'default',cpu:1,memMb:2048,timeoutMs:60000,lifecycle:{onTimeout:'kill'}});}
      catch {ledger.rejected(record,false);throw Error('DESKTOP_CREATE_UNKNOWN');}
      ledger.created(record,desktop.id);
      try {
        ledger.workAllowed();await desktop.connect();
        await route('GUI_DESKTOP_OBSERVATION',async()=>{
          const health=await desktop.health();
          if(!health.ready || !health.display || !health.vnc)throw Error('DESKTOP_GUI_NOT_READY');
          // Deterministic display setting; no inference about pixel meaning.
          await desktop.display.set(800,600);
          const dimensions=await desktop.display.size();
          if(dimensions.w!==800||dimensions.h!==600)throw Error('DISPLAY_SIZE');
          const result=await observeDesktop(desktop);add(result.evidence,result.bytes);return result.evidence;
        });report.cases.D1=success;
      }finally{
        try {await terminate(deps.compute,desktop);ledger.terminal('DESKTOP',desktop.id,'KILL_ACK_AND_CONFIRMED_ABSENCE');}
        catch{report.cases.D1='FAIL';ledger.uncertain();throw Error('DESKTOP_TERMINATION');}
        finally{desktop.close();}
      }
    }catch{if(ledger.snapshot().some(r=>r.kind==='DESKTOP'))report.cases.D1='FAIL';}
    try {
      const record=ledger.reserve('BROWSER');
      let browser;
      try {browser=await deps.browser.launch({retries:0,probe:false});}
      catch {ledger.rejected(record,false);throw Error('BROWSER_LAUNCH_OUTCOME_UNKNOWN');}
      ledger.created(record,browser.id);
      try {
        ledger.workAllowed();
        await route('WEB_INTERACTION_OR_DOM',async()=>{
          const page=await browser.newPage();
          await page.setContent(deterministicHtml,{timeout:15000,waitUntil:'domcontentloaded'});
          if(await page.title()!=='HITO evidence fixture')throw Error('DOM_FIXTURE_MISMATCH');
          const result=await observeBrowser(page,browser.id,'deterministic-inline-html');add(result.evidence,result.bytes);return result.evidence;
        });report.cases.B1=success;
      }finally{
        try {await browser.close();ledger.terminal('BROWSER',browser.id,'BROWSER_SESSION_CLOSE_RELEASE_AND_WAIT');}
        catch{report.cases.B1='FAIL';ledger.uncertain();throw Error('BROWSER_CLEANUP_UNCONFIRMED');}
      }
    }catch{if(ledger.snapshot().some(r=>r.kind==='BROWSER'))report.cases.B1='FAIL';}
    finally{try{await deps.browser.close();}catch{report.cases.B1='FAIL';}}
    const requirements=['SOURCE_OR_COMMAND_EXECUTION','GUI_DESKTOP_OBSERVATION','WEB_INTERACTION_OR_DOM','PERSISTENT_ARTIFACT_RETRIEVAL','NO_ROUTE'];
    report.routing=requirements.map(requirement=>{const primitive=selectRoute(requirement);return {requirement,primitive,execution:routed.has(primitive)?'OBSERVED_NOT_REQUIREMENT_PROVEN':primitive==='UNSUPPORTED'?'UNSUPPORTED':primitive==='VOLUME'&&options.volume==='disabled'?'DISABLED_NO_DISPATCH':'NOT_EXECUTED'};});
    const unsupported=await schedule('NO_ROUTE',{});
    report.cases.R1=routed.size===(options.volume==='disabled'?3:4)&&unsupported.status==='UNSUPPORTED'?success:'PARTIAL';
    report.resources=ledger.snapshot();return report;
  }
}
function status(error:unknown):number|undefined {
  return error!==null&&typeof error==='object'&&'status' in error&&typeof error.status==='number'?error.status:undefined;
}
