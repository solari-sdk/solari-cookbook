import test from 'node:test';
import assert from 'node:assert/strict';
import { createSolariProvider } from '../src/solari.ts';
import type { Manifest } from '../src/domain.ts';
const manifest: Manifest = {version:1,name:'test',source:{kind:'fixture',baseline:{},candidate:{}},setup:[],probe:{argv:['python3','probe.py'],files:{'probe.py':'print(1)'},expectedFailure:{exitCode:1,contains:'bad'},expectedSuccess:{contains:'good'}},limits:{sessionSeconds:120,commandSeconds:30}};
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
const created = {sandboxId:'sb-test',controlUrl:'wss://api.getsolari.com/control/sb-test',expiresAt:'2030-01-01T00:00:00Z'};
test('real SDK creates bounded base VM, sends fixed guest argv and deletes independently', async () => {
 const calls: {url:string;init:RequestInit}[]=[];
 const fetcher: typeof fetch = async (input,init) => { calls.push({url:String(input),init:init!}); return init?.method === 'DELETE' ? new Response(null,{status:204}) : String(input).endsWith('/exec') ? json({exitCode:0,stdout:'{"protocol":1}',stderr:''}) : json(created); };
 const p=createSolariProvider('secret-key',fetcher); const controller=new AbortController();
 const s=await p.create({runId:'run1',lane:'baseline',sessionSeconds:120},controller.signal);
 assert.deepEqual(await s.execute(manifest,'baseline',signal()),{protocol:1}); controller.abort(); await s.kill(signal());
 assert.deepEqual(JSON.parse(String(calls[0]!.init.body)),{template:'base',kind:'sandbox',cpu:1,memMb:2048,metadata:{patchproofRun:'run1',lane:'baseline'},timeoutMs:60000,lifecycle:{onTimeout:'kill'}});
 const exec=JSON.parse(String(calls[1]!.init.body)); assert.equal(exec.cmd,'python3'); assert.equal(exec.args[0],'-c');
 assert.deepEqual(JSON.parse(Buffer.from(exec.args[2],'base64').toString()),{source:manifest.source,lane:'baseline',setup:[],probe:manifest.probe,commandSeconds:30});
 assert.ok(!String(calls[1]!.init.body).includes('secret-key')); assert.equal(calls[2]!.init.method,'DELETE'); assert.equal(calls[0]!.init.redirect,'error');
});
test('SDK create retries retain the same idempotency key', async () => {
 const keys:string[]=[]; const p=createSolariProvider('key',async (_url,init)=>{keys.push(new Headers(init?.headers).get('Idempotency-Key')!); return keys.length===1 ? json({message:'busy'},503):json(created);});
 await p.create({runId:'r',lane:'baseline',sessionSeconds:120},signal()); assert.equal(keys.length,2); assert.ok(keys[0]); assert.equal(keys[0],keys[1]);
});
test('aborted stalled HTTP body stops without SDK retries', async () => {
 let attempts=0; const c=new AbortController(); const p=createSolariProvider('key',async ()=>{attempts++; return new Response(new ReadableStream({start(){}}));});
 const pending=p.create({runId:'r',lane:'baseline',sessionSeconds:120},c.signal); setTimeout(()=>c.abort(),20); await assert.rejects(pending,/abort|deadline/i); assert.equal(attempts,1);
});
for (const result of [{exitCode:1,stdout:'{}'},{exitCode:0,stdout:'oops'},{exitCode:0,stdout:'x'.repeat(140000)}]) test('rejects invalid outer execution '+result.stdout.length,async()=>{
 const p=createSolariProvider('key',async url=>String(url).endsWith('/exec')?json(result):json(created)); const s=await p.create({runId:'r',lane:'baseline',sessionSeconds:120},signal()); await assert.rejects(s.execute(manifest,'baseline',signal()));
});
test('HTTP oversized response is rejected and key-bearing errors are redacted',async()=>{
 const p=createSolariProvider('secret-key',async()=>json({message:'secret-key'+ 'x'.repeat(270000)},401)); await assert.rejects(p.create({runId:'r',lane:'baseline',sessionSeconds:120},signal()),error=>error instanceof Error && !error.message.includes('secret-key'));
});
test('unsupported exec fails closed without WebSocket fallback or replay',async()=>{
 let executions=0; const p=createSolariProvider('key',async url=>{if(String(url).endsWith('/exec')){executions++;return json({},404);} return json(created);});
 const s=await p.create({runId:'r',lane:'baseline',sessionSeconds:120},signal()); await assert.rejects(s.execute(manifest,'baseline',signal()),/one-shot/); assert.equal(executions,1);
});
test('provider error cannot expose its API key',async()=>{
 const p=createSolariProvider('secret-key',async()=>json({message:'error secret-key'},401)); await assert.rejects(p.create({runId:'r',lane:'baseline',sessionSeconds:120},signal()),/error \[REDACTED\]/);
});
test('redirected responses are rejected before accepting a session',async()=>{
 const p=createSolariProvider('key',async()=>{const response=json(created);Object.defineProperty(response,'redirected',{value:true});return response;}); await assert.rejects(p.create({runId:'r',lane:'baseline',sessionSeconds:120},signal()),/redirect/);
});
test('HTTP request deadline bounds a fetch implementation that ignores its abort signal',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let calls=0;const p=createSolariProvider('key',async()=>{calls++;return new Promise<Response>(()=>{});});
 const pending=p.create({runId:'r',lane:'baseline',sessionSeconds:120},signal());
 const rejection=assert.rejects(pending,/deadline/);t.mock.timers.tick(15000);await rejection;assert.equal(calls,1);
});
test('blocking exec can finish after 15 seconds while remaining within the session budget',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let finish!: (response:Response)=>void;
 let observed!: AbortSignal;
 let started!: ()=>void;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 const p=createSolariProvider('secret-key',async (url,init)=>{
   if(!String(url).endsWith('/exec')) return json(created);
   observed=init!.signal!; started(); return new Promise<Response>(resolve=>{finish=resolve;});
 });
 const s=await p.create({runId:'r',lane:'baseline',sessionSeconds:120},signal());
 const result=s.execute(manifest,'baseline',signal()); await ready;
 t.mock.timers.tick(16000); assert.equal(observed.aborted,false);
 finish(json({exitCode:0,stdout:'{}'})); assert.deepEqual(await result,{});
});
test('raw transport exception cannot disclose an API key',async()=>{
 const p=createSolariProvider('secret-key',async()=>{throw new Error('network failed secret-key');});
 await assert.rejects(p.create({runId:'r',lane:'baseline',sessionSeconds:120},signal()),error=>error instanceof Error && !error.message.includes('secret-key'));
});
test('blocking exec stops at the remaining session ceiling',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let started!: ()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
 const p=createSolariProvider('key',async url=>{
   if(!String(url).endsWith('/exec'))return json(created);
   started();return new Promise<Response>(()=>{});
 });
 const s=await p.create({runId:'r',lane:'baseline',sessionSeconds:20},signal());
 const result=s.execute(manifest,'baseline',signal()); const rejected=assert.rejects(result,/deadline/);
 await ready;t.mock.timers.tick(20000);await rejected;
});
