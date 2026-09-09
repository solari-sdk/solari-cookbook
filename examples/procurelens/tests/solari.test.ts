import test from 'node:test';
import assert from 'node:assert/strict';
import { createSolariServices } from '../src/solari.ts';
import { ServiceFailure } from '../src/model.ts';

test('invalid source fails safely before allocation', async () => {
  await assert.rejects(createSolariServices('test').acquire('https://evil.test', new AbortController().signal), (e: unknown) => e instanceof ServiceFailure && e.resource === 'browser' && e.released);
});
test('already cancelled processing does not allocate', async () => {
  await assert.rejects(createSolariServices('test').process({operation:'reconcile',internal:[],supplier:[]}, AbortSignal.abort()), (e: unknown) => e instanceof ServiceFailure && e.resource === 'sandbox' && e.released);
});

const input = { operation: 'reconcile' as const, internal: [], supplier: [] };
const source = 'https://www.adafruit.com/product/385';
const failure = (resource: string, released: boolean) => (e: unknown) => e instanceof ServiceFailure && e.resource === resource && e.released === released && !e.message.includes('private');
function sandboxHttp(options: { stdout?: string; killFails?: boolean; execFails?: boolean; createFails?: boolean; execWait?: boolean } = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const address = String(url), method = init?.method ?? 'GET';
    calls.push({url:address,method,body:init?.body ? JSON.parse(String(init.body)) : null});
    if (method === 'DELETE') return new Response(null, { status: options.killFails ? 500 : 204 });
    if (address.endsWith('/exec')) {
      if (options.execWait) return new Promise((_resolve,reject) => init?.signal?.addEventListener('abort', () => reject(new Error('private timeout')), {once:true}));
      return new Response(JSON.stringify({exitCode:options.execFails ? 1 : 0, stdout:options.stdout ?? '{"version":1}',stderr:'private'}));
    }
    return new Response(JSON.stringify({sandboxId:'opaque/private/id',controlUrl:'wss://private.test/control',expiresAt:'2027-01-01T00:00:00Z'}), {status:options.createFails ? 500 : 200});
  };
  return {fetch,calls};
}
test('sandbox uses one official SDK create, fixed python and kill before returning', async () => {
  const io=sandboxHttp();
  assert.deepEqual(await createSolariServices('credential',io).process(input,new AbortController().signal),{version:1});
  assert.deepEqual(io.calls.map(c=>c.method),['POST','POST','DELETE']);
  const creation=io.calls[0]!.body as Record<string,unknown>;
  assert.equal(creation.cpu,1); assert.equal(creation.memMb,2048); assert.deepEqual(creation.lifecycle,{onTimeout:'kill'});
  const command=io.calls[1]!.body as {cmd:string;args:string[]};
  assert.equal(command.cmd,'python3'); assert.equal(command.args[0],'-c');
  assert.match(command.args[1]!,/signal.alarm\(30\)/); assert.ok(!JSON.stringify(command).includes('credential'));
  assert.deepEqual(JSON.parse(Buffer.from(command.args[2]!,'base64').toString()),input);
});
for (const [name, options, released] of [
  ['malformed JSON',{stdout:'private invalid'},true], ['non-object JSON',{stdout:'null'},true],
  ['nonzero exit',{execFails:true},true], ['kill failure',{killFails:true},false], ['create error',{createFails:true},false],
] as const) test(`sandbox ${name} produces safe failure and no retry`,async()=>{
  const io=sandboxHttp(options); await assert.rejects(createSolariServices('test',io).process(input,new AbortController().signal),failure('sandbox',released));
  assert.equal(io.calls.filter(c=>c.url.endsWith('/sandboxes')).length,1);
  assert.equal(io.calls.filter(c=>c.method==='DELETE').length,options.createFails ? 0 : 1);
});
test('sandbox deadline kills with an independent cleanup signal',async()=>{
  const io=sandboxHttp({execWait:true});
  const keepAlive=setTimeout(()=>{},1000);
  try { await assert.rejects(createSolariServices('test',{...io,workMs:30,cleanupMs:100}).process(input,new AbortController().signal),failure('sandbox',true)); }
  finally {clearTimeout(keepAlive);}
  assert.equal(io.calls.at(-1)?.method,'DELETE');
});

import type { Browser } from 'patchright-core';
import type { Solari } from '@solarisdk/browser';
function browserIo(options: { connectFails?: boolean; navigateFails?: boolean; closeFails?: boolean; releaseFails?: boolean }={}) {
  const calls:string[]=[];
  const client={sessions:{create:async()=>{calls.push('create');return {id:'opaque-private',wsEndpoint:'wss://private.test',cdpEndpoint:'wss://private.test',expiresAt:''};},releaseAndWait:async()=>{calls.push('release');if(options.releaseFails)throw Error('private');}},close:async()=>{calls.push('client-close');}} as unknown as Pick<Solari,'sessions'|'close'>;
  const page={goto:async()=>{calls.push('navigate');if(options.navigateFails)throw Error('private');return {ok:()=>true,status:()=>200};},url:()=>source,evaluate:async()=>({fragments:['{"@type":"Product"}'],visible:[{sku:'385',name:'Sensor',price:'9.95',availability:'No longer stocked'}]})};
  const browser={newContext:async(options:unknown)=>{assert.deepEqual(options,{serviceWorkers:'block'});return {route:async()=>{},newPage:async()=>page};},close:async()=>{calls.push('browser-close');if(options.closeFails)throw Error('private');}} as unknown as Browser;
  return {calls,browser:()=>client,connect:async()=>{calls.push('connect');if(options.connectFails)throw Error('private');return browser;}};
}
test('browser successful capture waits for remote release and local close',async()=>{
  const io=browserIo(); const result=await createSolariServices('test',io).acquire(source,new AbortController().signal);
  assert.equal(result.sourceUrl,source); assert.equal(result.adapter,'adafruit-jsonld-v1');
  assert.deepEqual(io.calls,['create','connect','navigate','release','browser-close','client-close']);
});
for (const [name,options,released] of [ ['connect failure',{connectFails:true},true],['navigation failure',{navigateFails:true},true],['disconnect failure',{closeFails:true},true],['release failure',{releaseFails:true},false] ] as const) test(`browser ${name} closes every known resource`,async()=>{
  const io=browserIo(options); await assert.rejects(createSolariServices('test',io).acquire(source,new AbortController().signal),failure('browser',released));
  assert.equal(io.calls.filter(c=>c==='create').length,1);assert.ok(io.calls.includes('release'));assert.equal(io.calls.at(-1),'client-close');
});
