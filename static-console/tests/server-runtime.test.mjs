import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isServerWorkspace,
  normalizeServerEntity,
  normalizeServerEvent,
  normalizeServerEvidence,
  normalizeServerRelationship,
  normalizeServerSourceState,
} from '../server-runtime.js';

test('runtime mode is path-scoped so standalone static hosting performs no API probe', () => {
  assert.equal(isServerWorkspace({ pathname: '/' }), false);
  assert.equal(isServerWorkspace({ pathname: '/static-console/' }), false);
  assert.equal(isServerWorkspace({ pathname: '/workspace/' }), true);
  assert.equal(isServerWorkspace({ pathname: '/workspace/case' }), true);
});

test('server rows normalize into the shared browser workspace contract', () => {
  const event = normalizeServerEvent({
    id: 'event:1', source_id: 'public-source', source_record_id: '1', category: 'test', title: 'Observed record',
    observed_at: '2026-09-01T12:00:00Z', latitude: '49.25', longitude: '-122.95', geo_precision: 'point',
    quality_score: '0.8', properties_json: '{"value":4}', evidence_json: '[{"kind":"observed"}]', sighting_count: 2,
  });
  assert.deepEqual(event.location, { latitude: 49.25, longitude: -122.95, precision: 'point', crs: 'EPSG:4326' });
  assert.equal(event.properties.value, 4);
  assert.equal(event.evidence[0].kind, 'observed');
  assert.equal(event.quality_score, 0.8);
  assert.equal(event.sighting_count, 2);

  const entity = normalizeServerEntity({
    id: 'entity:1', type: 'location', label: 'Example', aliases_json: '["Alias"]', confidence: 0.7,
    properties_json: '{}', evidence_json: '[]', latitude: 49.2, longitude: -123.1,
  });
  assert.deepEqual(entity.aliases, ['Alias']);
  assert.equal(entity.location.latitude, 49.2);

  const relationship = normalizeServerRelationship({
    id: 'relationship:1', source_entity_id: 'entity:1', target_entity_id: 'entity:2', type: 'related-to',
    confidence: '0.6', observed: 1, properties_json: '{}', evidence_json: '[]',
  });
  assert.equal(relationship.observed, true);
  assert.equal(relationship.confidence, 0.6);

  const evidence = normalizeServerEvidence({ event_id: 'event:1', kind: 'observed', field: 'title' }, 3);
  assert.equal(evidence.id, 'server-evidence:event:1:observed:title');
});

test('server health normalization preserves authoritative source attribution', () => {
  const descriptors = new Map([['public-source', { authoritative_url: 'https://example.org/public-feed' }]]);
  const state = normalizeServerSourceState({
    source_id: 'public-source', last_status: 'success', last_completed_at: '2026-09-01T12:00:00Z',
    age_seconds: 30, stale: false,
  }, descriptors);
  assert.equal(state.id, 'public-source');
  assert.equal(state.last_success, '2026-09-01T12:00:00Z');
  assert.equal(state.url, 'https://example.org/public-feed');
  assert.equal(state.age_seconds, 30);
  assert.equal(state.stale, false);
});
