/** Application-owned resource accounting. Importing this module creates nothing. */
import { SandboxClient } from '@solarisdk/sandbox';
import { Solari } from '@solarisdk/browser';
export type ResourceKind = 'SANDBOX' | 'DESKTOP' | 'BROWSER' | 'VOLUME' | 'SNAPSHOT';
export const ceilings = Object.freeze({SANDBOX:3,DESKTOP:1,BROWSER:1,VOLUME:1,SNAPSHOT:0});
export interface ResourceRecord {kind:ResourceKind; attempt:number; id?:string; state:'DISPATCHING'|'CREATED'|'UNKNOWN'|'REJECTED'|'TERMINAL'; basis?:string}
export class ResourceLedger {
  private records:ResourceRecord[]=[];
  private stopped=false;
  private sink:(records:ResourceRecord[])=>void;
  constructor(sink:(records:ResourceRecord[])=>void) {this.sink=sink;}
  snapshot() {return structuredClone(this.records);}
  private save() {this.sink(this.snapshot());}
  reserve(kind:ResourceKind) {
    const attempt=this.records.filter(r=>r.kind===kind).length+1;
    if(this.stopped || attempt>ceilings[kind]) throw Error('RESOURCE_BUDGET_OR_STOP');
    const record:ResourceRecord={kind,attempt,state:'DISPATCHING'};
    this.records.push(record);
    try {this.save();} catch {this.stopped=true;throw Error('LEDGER_PERSIST_FAILED');}
    return record;
  }
  created(record:ResourceRecord,id:string) {
    record.id=id;record.state='CREATED';
    if(!id || this.records.some(r=>r!==record && r.id===id))this.stopped=true;
    try {this.save();}catch{this.stopped=true;}
  }
  workAllowed() {if(this.stopped)throw Error('RESOURCE_STOPPED');}
  rejected(record:ResourceRecord,knownRejection:boolean) {
    record.state=knownRejection?'REJECTED':'UNKNOWN';
    if(!knownRejection)this.stopped=true;
    this.save();
  }
  terminal(kind:ResourceKind,id:string,basis:string) {
    const record=this.records.find(r=>r.kind===kind && r.id===id && r.state==='CREATED');
    if(!record)throw Error('UNTRACKED_TERMINATION');
    record.state='TERMINAL';record.basis=basis;this.save();
  }
  uncertain() {this.stopped=true;this.save();}
}
/** Gate every creation dispatch, including automatic SDK HTTP retries. */
export function guardedComputeFetch(real:typeof fetch,volume:'enabled'|'disabled'='enabled'):typeof fetch {
  const counts={SANDBOX:0,DESKTOP:0,VOLUME:0};
  const keys=new Set<string>();
  return async(input,init)=>{
    const req=new Request(input,init);
    const url=new URL(req.url);
    if(url.origin!=='https://api.getsolari.com' || url.pathname.includes('snapshot'))throw Error('DISALLOWED_ENDPOINT');
    if(volume==='disabled' && /(?:^|\/)volumes(?:\/|$)/.test(url.pathname))throw Error('VOLUME_DISABLED');
    if(req.method==='POST' && (url.pathname==='/sandboxes'||url.pathname==='/volumes')) {
      const body=await req.clone().json() as Record<string,unknown>;
      if(body.fromSnapshot)throw Error('NO_SNAPSHOT');
      const kind=url.pathname==='/volumes'?'VOLUME':body.kind==='desktop'?'DESKTOP':'SANDBOX';
      const key=req.headers.get('Idempotency-Key');
      if(!key || keys.has(key) || counts[kind]>=ceilings[kind])throw Error('DISPATCH_BUDGET_OR_RETRY');
      keys.add(key);counts[kind]++;
    }
    return real(req);
  };
}
export function officialClients(key:string,volume:'enabled'|'disabled'='enabled') {
  if(!key.trim())throw Error('SOLARI_CREDENTIAL_REQUIRED');
  return {
    compute:new SandboxClient({apiKey:key,baseUrl:'https://api.getsolari.com',callTimeoutMs:30000,fetch:guardedComputeFetch(fetch,volume)}),
    browser:new Solari({apiKey:key,baseUrl:'https://api.getsolari.com',maxAttempts:1,timeoutMs:30000}),
  };
}
