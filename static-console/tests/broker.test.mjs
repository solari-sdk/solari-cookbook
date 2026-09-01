import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_BROKER_RESPONSE_BYTES, normalizeBrokerEndpoint } from '../broker.js';
import { fetchStaticSource } from '../sources.js';


test('broker endpoints require HTTPS except loopback development', () => {
  assert.equal(normalizeBrokerEndpoint(''), '');
  assert.equal(normalizeBrokerEndpoint('https://broker.example.test/fetch'), 'https://broker.example.test/fetch');
  assert.equal(normalizeBrokerEndpoint('http://localhost:8787/'), 'http://localhost:8787/');
  assert.throws(() => normalizeBrokerEndpoint('http://broker.example.test/'), /HTTPS/);
  assert.throws(() => normalizeBrokerEndpoint('https://user:secret@broker.example.test/'), /embedded credentials/);
  assert.throws(() => normalizeBrokerEndpoint('https://broker.example.test/?token=secret'), /query string/);
  assert.ok(MAX_BROKER_RESPONSE_BYTES >= 1024 * 1024);
});


test('static source falls back to configured broker after direct browser fetch failure', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const upstreamBody = JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', id: 'fixture-quake', geometry: { type: 'Point', coordinates: [-122.3, 47.6, 10] },
      properties: { mag: 4.2, place: 'Public fixture', time: 1788264000000, updated: 1788264060000, type: 'earthquake', tsunami: 0, url: 'https://earthquake.usgs.gov/fixture' },
    }],
  });
  try {
    globalThis.fetch = async (_url, options = {}) => {
      calls += 1;
      if (calls === 1) throw new TypeError('simulated CORS/network rejection');
      assert.equal(options.method, 'POST');
      const request = JSON.parse(options.body);
      assert.equal(request.operation, 'public-source-fetch');
      assert.equal(request.source_id, 'usgs-earthquakes');
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ status: 200, final_url: request.source_url, content_type: 'application/geo+json', body_text: upstreamBody });
        },
      };
    };
    const result = await fetchStaticSource('usgs-earthquakes', undefined, { brokerEndpoint: 'https://broker.example.test/fetch' });
    assert.equal(calls, 2);
    assert.equal(result.route, 'broker-fallback');
    assert.equal(result.acquisition.metadata.route, 'broker-fallback');
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].source_record_id, 'fixture-quake');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('static source reports a routing requirement when direct browser access fails and no broker exists', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('simulated CORS/network rejection'); };
    await assert.rejects(() => fetchStaticSource('usgs-earthquakes'), /Configure the optional broker/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
