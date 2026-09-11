import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SandboxClient} from '@solarisdk/sandbox';
import {guardedComputeFetch,ceilings} from '../src/stretch-resources.ts';
const harness=readFileSync(new URL('../src/stretch-harness.ts',import.meta.url),'utf8');
const desktopBlock=harness.slice(harness.indexOf("ledger.reserve('DESKTOP')"),harness.indexOf("ledger.reserve('BROWSER')"));
function wire(){
  const requests:Request[]=[];
  const guarded=guardedComputeFetch(async(input,init)=>{
    const req=new Request(input,init);requests.push(req.clone());
    const body=await req.json() as Record<string,unknown>;
    const response=new URL(req.url).pathname==='/volumes'?{volumeId:'fixture-volume',name:'fixture'}:
      {sandboxId:'fixture-'+requests.length,kind:body.kind,controlUrl:'wss://invalid.example/control',streamUrl:'wss://invalid.example/stream',expiresAt:'2099-01-01T00:00:00Z'};
    return new Response(JSON.stringify(response),{status:201,headers:{'Content-Type':'application/json'}});
  });
  return {requests,guarded,client:new SandboxClient({apiKey:'offline-fixture',baseUrl:'https://api.getsolari.com',fetch:guarded})};
}
test('DESKTOP_USES_DOCUMENTED_GUI_TEMPLATE',()=>assert.match(desktopBlock,/createDesktop\(\{template:'default'/));
test('DESKTOP_NO_XSETROOT_DEPENDENCY',()=>assert.doesNotMatch(desktopBlock,/xsetroot|commands\.run|\.exec\(/));
test('DESKTOP_NATIVE_SCREENSHOT_ONLY',()=>{
  assert.match(desktopBlock,/await desktop\.health\(\)/);assert.match(desktopBlock,/!health\.ready \|\| !health\.display \|\| !health\.vnc/);
  assert.equal((desktopBlock.match(/await observeDesktop\(desktop\)/g)||[]).length,1);
  const adapter=readFileSync(new URL('../src/routing.ts',import.meta.url),'utf8');assert.match(adapter,/await desktop\.screenshot\(\{format:'png'\}\)/);
  assert.match(desktopBlock,/await terminate\(deps\.compute,desktop\)/);
});
test('SANDBOX_REAL_SDK_REQUEST_SHAPE',async()=>{const w=wire();const s=await w.client.create({template:'base'});s.close();assert.equal(w.requests.length,1);assert.equal(w.requests[0].method,'POST');assert.equal(new URL(w.requests[0].url).pathname,'/sandboxes');assert.deepEqual(await w.requests[0].json(),{template:'base',kind:'sandbox'});});
test('SANDBOX_IDEMPOTENCY_PRESENT',async()=>{const w=wire();const s=await w.client.create({template:'base'});s.close();assert(w.requests[0].headers.get('Idempotency-Key'));await assert.rejects(w.guarded(w.requests[0].clone()),/RETRY/);assert.equal(w.requests.length,1);});
test('DESKTOP_REAL_SDK_REQUEST_SHAPE',async()=>{const w=wire();const d=await w.client.createDesktop({template:'default'});d.close();assert.equal(new URL(w.requests[0].url).pathname,'/sandboxes');assert.equal(w.requests[0].method,'POST');assert.deepEqual(await w.requests[0].json(),{template:'default',kind:'desktop'});assert(w.requests[0].headers.get('Idempotency-Key'));});
test('DESKTOP_CLASSIFIED_SEPARATELY_FROM_SANDBOX',async()=>{const w=wire();(await w.client.createDesktop({template:'default'})).close();for(let i=0;i<3;i++)(await w.client.create({template:'base'})).close();assert.equal(w.requests.length,4);await assert.rejects(w.guarded('https://api.getsolari.com/sandboxes',{method:'POST',headers:{'Idempotency-Key':'second-desktop'},body:JSON.stringify({kind:'desktop'})}));assert.equal(w.requests.length,4);});
test('VOLUME_REAL_SDK_REQUEST_SHAPE',async()=>{const w=wire();const v=await w.client.volumes.create({name:'fixture'});assert.equal(v.volumeId,'fixture-volume');assert.equal(w.requests[0].method,'POST');assert.equal(new URL(w.requests[0].url).pathname,'/volumes');assert.deepEqual(await w.requests[0].json(),{name:'fixture'});assert(w.requests[0].headers.get('Idempotency-Key'));});
test('VOLUME_DISPATCH_GUARD_MATCHES_REAL_SDK',async()=>{const w=wire();await w.client.volumes.create({name:'fixture'});await assert.rejects(w.guarded(w.requests[0].clone()),/RETRY/);await assert.rejects(w.guarded('https://api.getsolari.com/volumes',{method:'POST',headers:{'Idempotency-Key':'replacement-volume'},body:'{}'}));assert.equal(w.requests.length,1);});
test('BROWSER_SINGLE_ATTEMPT_POLICY_PRESERVED',()=>{const r=readFileSync(new URL('../src/stretch-resources.ts',import.meta.url),'utf8');assert.match(r,/maxAttempts:1/);assert.match(harness,/launch\(\{retries:0,probe:false\}\)/);assert.equal(ceilings.BROWSER,1);});
test('ORIGINAL_RESOURCE_CEILINGS_PRESERVED',()=>assert.deepEqual(ceilings,{SANDBOX:3,DESKTOP:1,BROWSER:1,VOLUME:1,SNAPSHOT:0}));
test('NO_NETWORK_DURING_TESTS',async()=>{const previous=globalThis.fetch;let escaped=0;globalThis.fetch=async()=>{escaped++;throw Error('FORBIDDEN_NETWORK');};try{const w=wire();(await w.client.create({template:'base'})).close();(await w.client.createDesktop({template:'default'})).close();await w.client.volumes.create({name:'fixture'});assert.equal(w.requests.length,3);assert.equal(escaped,0);}finally{globalThis.fetch=previous;}});
