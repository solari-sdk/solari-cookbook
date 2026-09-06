import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { SandboxClient } from '@solarisdk/sandbox';
import { safeText } from './domain.ts';
import type { Provider } from './runner.ts';

const ORIGIN = 'https://api.getsolari.com';
const RESPONSE_LIMIT = 256 * 1024;
const STDOUT_LIMIT = 128 * 1024;
const stopped = (message: string) => new Response(JSON.stringify({message,retryable:false}), {status:408,headers:{'Content-Type':'application/json'}});

export function createSolariProvider(apiKey: string, fetchImpl: typeof fetch = fetch): Provider {
  if (!apiKey.trim()) throw new Error('A Solari API key is required');
  const scope = new AsyncLocalStorage<{signal:AbortSignal; timeoutMs:number}>();
  const boundedFetch: typeof fetch = async (input, init) => {
    const operationScope = scope.getStore();
    const operationSignal = operationScope?.signal;
    if (!operationSignal || operationSignal.aborted) return stopped('Solari operation aborted');
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== ORIGIN || url.username || url.password) return stopped('Solari origin rejected');
    const controller = new AbortController();
    const abort = () => controller.abort();
    operationSignal.addEventListener('abort', abort, {once:true});
    init?.signal?.addEventListener('abort', abort, {once:true});
    if (init?.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, operationScope!.timeoutMs);
    let onAbort: (() => void) | undefined;
    try {
      const interrupted = new Promise<Response>(resolve => {
        onAbort = () => resolve(stopped('Solari HTTP deadline exceeded or operation aborted'));
        controller.signal.addEventListener('abort',onAbort,{once:true});
        if (controller.signal.aborted) onAbort();
      });
      const request = (async () => {
        if (controller.signal.aborted) return stopped('Solari operation aborted');
        const response = await fetchImpl(input,{...init,signal:controller.signal,redirect:'error'});
        if (response.redirected || (response.url && new URL(response.url).origin !== ORIGIN)) return stopped('Solari redirect rejected');
        const reader = response.body?.getReader();
        const chunks: Uint8Array[]=[]; let size=0;
        if (reader) {
          const cancelReader = () => { void reader.cancel().catch(()=>{}); };
          controller.signal.addEventListener('abort',cancelReader,{once:true});
          try {
            for (;;) {
              const {done,value}=await reader.read(); if (done) break;
              size += value.byteLength;
              // On create, a rejected or lost response can still mean allocation occurred. The runner records creation uncertainty.
              if (size > RESPONSE_LIMIT) { void reader.cancel().catch(()=>{}); return stopped('Solari response exceeds 256 KiB'); }
              chunks.push(value);
            }
          } finally { controller.signal.removeEventListener('abort',cancelReader); reader.releaseLock(); }
        }
        // The SDK falls back to WebSockets on 404/501; unsupported REST must fail closed.
        if (url.pathname.endsWith('/exec') && [404,501].includes(response.status)) return stopped('Solari one-shot exec route unavailable');
        return new Response(size ? Buffer.concat(chunks) : null,{status:response.status,headers:response.headers});
      })();
      return await Promise.race([request,interrupted]);
    } catch {
      // A transport exception is ambiguous; avoid SDK retries after a timeout or redirect error.
      return stopped('Solari HTTP request failed');
    } finally {
      clearTimeout(timer); operationSignal.removeEventListener('abort',abort); init?.signal?.removeEventListener('abort',abort);
      if (onAbort) controller.signal.removeEventListener('abort',onAbort);
    }
  };
  const client = new SandboxClient({apiKey,baseUrl:ORIGIN,fetch:boundedFetch});
  async function operation<T>(signal:AbortSignal, action:()=>Promise<T>, timeoutMs=15000):Promise<T> {
    try { return await scope.run({signal,timeoutMs},action); }
    catch(error) { throw new Error(safeText(error instanceof Error ? error.message : String(error),[apiKey])); }
  }
  const cleanup = (id:string,signal:AbortSignal) => operation(signal,()=>client.kill(id));
  return {
    kind:'solari',cleanup,
    async create(context,signal) {
      const deadline=Date.now()+context.sessionSeconds*1000;
      const sandbox=await operation(signal,()=>client.create({template:'base',cpu:1,memMb:2048,timeoutMs:60000,lifecycle:{onTimeout:'kill'},metadata:{patchproofRun:context.runId,lane:context.lane}}));
      if (typeof sandbox.id !== 'string' || !sandbox.id) throw new Error('Solari create returned no session ID; allocation is uncertain');
      return {
        id:sandbox.id,
        kill: cleanupSignal=>cleanup(sandbox.id,cleanupSignal),
        async execute(manifest,lane,executeSignal) {
          let script: string;
          try { script=await readFile(new URL('../guest/runner.py',import.meta.url),'utf8'); }
          catch { script=await readFile(new URL('../../guest/runner.py',import.meta.url),'utf8'); }
          const remaining=deadline-Date.now();
          if (remaining<=0 || executeSignal.aborted) throw new Error('Solari session deadline exceeded or aborted');
          const payload=Buffer.from(JSON.stringify({source:manifest.source,lane,setup:manifest.setup,probe:manifest.probe,commandSeconds:manifest.limits.commandSeconds})).toString('base64');
          const result=await operation(executeSignal,()=>sandbox.commands.run('python3',{args:['-c',script,payload],timeoutMs:remaining}),Math.min(remaining,300000));
          if (!result || result.exitCode!==0 || typeof result.stdout!=='string' || Buffer.byteLength(result.stdout)>STDOUT_LIMIT) throw new Error('Solari guest runner failed or output exceeded 128 KiB');
          try { return JSON.parse(result.stdout) as unknown; }
          catch { throw new Error('Solari guest runner returned malformed JSON'); }
        },
      };
    },
  };
}


