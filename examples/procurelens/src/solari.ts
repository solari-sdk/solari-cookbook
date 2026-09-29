import { readFile } from 'node:fs/promises';
import { Solari, type Session } from '@solarisdk/browser';
import { SandboxClient, type Sandbox } from '@solarisdk/sandbox';
import { chromium, type Browser } from 'patchright-core';
import { ServiceFailure, supplierUrl, type Capture, type Services } from './model.ts';

type BrowserClient = Pick<Solari, 'sessions' | 'close'>;
type Boundary = { browser?: (key: string) => BrowserClient; connect?: (endpoint: string) => Promise<Browser>; fetch?: typeof fetch; workMs?: number; cleanupMs?: number };
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Stopped'));
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error('Stopped'));
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
async function processor(): Promise<string> {
  try { return await readFile(new URL('../processor.py', import.meta.url), 'utf8'); }
  catch { return readFile(new URL('../../processor.py', import.meta.url), 'utf8'); }
}

// The optional boundary replaces only external I/O; production uses the pinned official SDKs.
export function createSolariServices(apiKey: string, boundary: Boundary = {}): Services {
  const workMs = boundary.workMs ?? 45_000, cleanupMs = boundary.cleanupMs ?? 10_000;
  return {
    async acquire(url, caller) {
      try { supplierUrl(url); caller.throwIfAborted(); } catch { throw new ServiceFailure('browser', true); }
      const signal = AbortSignal.any([caller, AbortSignal.timeout(workMs)]);
      let client: BrowserClient | undefined, session: Session | undefined, browser: Browser | undefined;
      let started = false, stopped = false, released = false, failed = false;
      let result: Capture | undefined;
      const release = async (owned: Session) => { await client!.sessions.releaseAndWait(owned.id); released = true; };
      try {
        client = boundary.browser?.(apiKey) ?? new Solari({ apiKey, maxAttempts: 1, timeoutMs: 30_000 });
        started = true;
        session = await bounded(client.sessions.create({ recording: false }).then(async value => {
          if (stopped) { await bounded(release(value), AbortSignal.timeout(cleanupMs)); await client!.close(); throw new Error('Late allocation'); }
          return value;
        }), signal);
        browser = await bounded((boundary.connect ?? (endpoint => chromium.connect(endpoint, { timeout: 30_000 })))(session!.wsEndpoint).then(async value => {
          if (stopped) { await value.close(); throw new Error('Late connection'); }
          return value;
        }), signal);
        const context = await bounded(browser!.newContext({ serviceWorkers: 'block' }), signal);
        await bounded(context.route('**/*', route => {
          const request = route.request();
          const allowed = new URL(request.url()).origin === new URL(url).origin && !['image', 'media', 'font'].includes(request.resourceType()) && (!request.isNavigationRequest() || request.url() === url);
          return allowed ? route.continue() : route.abort();
        }), signal);
        const page = await bounded(context.newPage(), signal);
        const response = await bounded(page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }), signal);
        if (!response?.ok() || page.url() !== url) throw new Error('Navigation rejected');
        const evidence = await bounded(page.evaluate(() => {
          const body = document.body.innerText;
          if (body.length > 150_000) throw new Error('Oversized DOM');
          const heading = Array.from(document.querySelectorAll('h1')).find(node => node instanceof HTMLElement && node.checkVisibility());
          if (!(heading instanceof HTMLElement) || !heading.checkVisibility()) throw new Error('Missing heading');
          const name = heading.innerText.trim();
          const sku = body.match(/Product ID:\s*(\d+)/i)?.[1];
          const price = body.match(/\$\s*(\d+(?:\.\d{2})?)/)?.[1];
          const availability = body.match(/No longer stocked|Out of stock|In stock|Pre-?order|Back-?order/i)?.[0];
          if (!sku || !price || !availability || !name || name.length > 300) throw new Error('Incomplete visible evidence');
          const products: Record<string, unknown>[] = [];
          function visit(value: unknown, depth = 0): void {
            if (depth > 10) throw new Error('Nested metadata');
            if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
            if (!value || typeof value !== 'object') return;
            const item = value as Record<string, unknown>;
            if (item['@type'] === 'Product' || Array.isArray(item['@type']) && item['@type'].includes('Product')) products.push(item);
            if (item['@graph']) visit(item['@graph'], depth + 1);
          }
          let total = 0;
          for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
            const raw = node.textContent ?? ''; total += raw.length;
            if (total > 150_000) throw new Error('Oversized metadata');
            visit(JSON.parse(raw));
          }
          if (products.length !== 1) throw new Error('Unexpected product scope');
          const product = products[0]!;
          if (String(product.sku) !== sku) throw new Error('Wrong product');
          const offers = product.offers;
          if (!offers || typeof offers !== 'object' || Array.isArray(offers)) throw new Error('Unsupported offers');
          const offer = offers as Record<string, unknown>;
          for (const value of [product.sku, product.name, offer.price, offer.priceCurrency, offer.availability]) {
            if (!['string', 'number'].includes(typeof value) || String(value).length > 500) throw new Error('Missing product facts');
          }
          const fragments = [JSON.stringify({ '@type': 'Product', sku: product.sku, name: product.name, offers: { price: offer.price, priceCurrency: offer.priceCurrency, availability: offer.availability } })];
          if (fragments[0]!.length > 65_536) throw new Error('Oversized fragment');
          return { fragments, visible: [{ sku, name, price, availability }] };
        }), signal);
        if (evidence.visible[0]?.sku !== url.split('/').at(-1) || Buffer.byteLength(JSON.stringify(evidence.fragments)) > 65_536) throw new Error('Wrong scope');
        result = { adapter: 'adafruit-jsonld-v1', sourceUrl: url, observedAt: new Date().toISOString(), httpStatus: response.status(), complete: true, ...evidence };
      } catch { failed = true; }
      finally {
        stopped = true;
        const cleanup = AbortSignal.timeout(cleanupMs);
        // Release is independent of a hanging/failed Playwright disconnect.
        const outcomes = await Promise.allSettled([
          session ? bounded(release(session), cleanup) : Promise.resolve(),
          browser ? bounded(browser.close(), cleanup) : Promise.resolve(),
        ]);
        if (outcomes.some(item => item.status === 'rejected')) failed = true;
        try { if (client) await bounded(client.close(), cleanup); } catch { failed = true; }
      }
      if (failed || !result || !released) throw new ServiceFailure('browser', released || !started);
      return result;
    },
    async process(input, caller) {
      try { caller.throwIfAborted(); } catch { throw new ServiceFailure('sandbox', true); }
      const signal = AbortSignal.any([caller, AbortSignal.timeout(workMs)]);
      let sandbox: Sandbox | undefined, stopped = false, started = false, released = false, failed = false;
      let output: unknown;
      const sent = new Set<string>();
      const limitedFetch: typeof fetch = async (resource, init) => {
        const method = init?.method ?? 'GET';
        const key = `${method} ${String(resource)}`;
        // Return a non-retryable SDK error, including on network errors; never send twice.
        const reject = () => new Response('{"error":"operation_failed"}', { status: 400 });
        if (sent.has(key)) return reject();
        sent.add(key);
        const opSignal = method === 'DELETE' ? AbortSignal.timeout(cleanupMs) : signal;
        try {
          const response = await (boundary.fetch ?? globalThis.fetch)(resource, { ...init, signal: opSignal, redirect: 'error' });
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = []; let size = 0;
          if (reader) {
            try {
              for (;;) {
                const chunk = await bounded(reader.read(), method === 'POST' && String(resource).endsWith('/sandboxes') ? AbortSignal.timeout(cleanupMs) : opSignal);
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > 524_288) throw new Error('Oversized response');
                chunks.push(chunk.value);
              }
            } catch { void reader.cancel().catch(() => {}); throw new Error('Invalid response'); }
          }
          if (!response.ok) return reject();
          return new Response(size ? Buffer.concat(chunks) : null, { status: response.status });
        } catch { return reject(); }
      };
      const kill = async (owned: Sandbox) => { try { await owned.kill(); released = true; } finally { owned.close(); } };
      try {
        const code = await bounded(processor(), signal);
        const serialized = JSON.stringify(input);
        if (Buffer.byteLength(serialized) > 90_000) throw new Error('Oversized input');
        const client = new SandboxClient({ apiKey, baseUrl: 'https://api.getsolari.com', fetch: limitedFetch, callTimeoutMs: 30_000 });
        started = true;
        sandbox = await bounded(client.create({ template: 'base', cpu: 1, memMb: 2048, timeoutMs: 60_000, lifecycle: { onTimeout: 'kill' } }).then(async value => {
          if (stopped) { await bounded(kill(value), AbortSignal.timeout(cleanupMs)); throw new Error('Late allocation'); }
          return value;
        }), signal);
        const wrapper = `import signal,sys,io,base64\nsignal.alarm(30)\nsys.stdin=io.TextIOWrapper(io.BytesIO(base64.b64decode(sys.argv[1])),encoding='utf-8')\n${code}`;
        const result = await bounded(sandbox!.commands.run('python3', { args: ['-c', wrapper, Buffer.from(serialized).toString('base64')], timeoutMs: 30_000 }), signal);
        if (result.exitCode !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 524_288) throw new Error('Invalid result');
        output = JSON.parse(result.stdout);
        if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Invalid result');
      } catch { failed = true; }
      finally {
        stopped = true;
        if (sandbox) { try { await bounded(kill(sandbox), AbortSignal.timeout(cleanupMs)); } catch { failed = true; } finally { sandbox.close(); } }
      }
      if (failed || !released) throw new ServiceFailure('sandbox', released || !started);
      return output;
    },
  };
}
