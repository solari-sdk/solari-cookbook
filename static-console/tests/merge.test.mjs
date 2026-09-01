import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeRecordSets } from '../merge.js';

test('merge accepts new and newer records but preserves newer local records',()=>{
  const existing=[{id:'a',updated_at:'2026-09-01T10:00:00Z',value:1},{id:'b',updated_at:'2026-09-01T12:00:00Z',value:1}];
  const incoming=[{id:'a',updated_at:'2026-09-01T11:00:00Z',value:2},{id:'b',updated_at:'2026-09-01T11:00:00Z',value:2},{id:'c',value:3}];
  const result=mergeRecordSets(existing,incoming);
  assert.deepEqual(result.accepted.map((item)=>item.id),['a','c']);
  assert.equal(result.stats.kept_existing,1);
  assert.equal(result.stats.unresolved,0);
});

test('merge does not overwrite divergent records without comparable time',()=>{
  const result=mergeRecordSets([{id:'a',value:1}],[{id:'a',value:2}]);
  assert.equal(result.accepted.length,0);
  assert.equal(result.unresolved.length,1);
  assert.equal(result.unresolved[0].reason,'divergent-record-without-comparable-timestamp');
});

test('merge reports exact duplicates and missing ids',()=>{
  const record={id:'a',value:1};
  const result=mergeRecordSets([record],[record,{value:2}]);
  assert.equal(result.stats.duplicates,1);
  assert.equal(result.unresolved[0].reason,'missing-id');
});
