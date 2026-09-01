import test from 'node:test';
import assert from 'node:assert/strict';

import { graphLayout } from '../graph.js';

test('graph layout is deterministic and filters dangling edges',()=>{
  const entities=[{id:'a',label:'A'},{id:'b',label:'B'}];
  const relationships=[{id:'r1',source_entity_id:'a',target_entity_id:'b'},{id:'r2',source_entity_id:'a',target_entity_id:'missing'}];
  const first=graphLayout(entities,relationships,{width:400,height:300});
  const second=graphLayout(entities,relationships,{width:400,height:300});
  assert.deepEqual(first,second);
  assert.equal(first.nodes.length,2);
  assert.equal(first.edges.length,1);
  assert.equal(first.truncated,false);
});

test('graph layout enforces visual safety bounds',()=>{
  const entities=Array.from({length:120},(_,index)=>({id:`e${index}`}));
  const layout=graphLayout(entities,[],{maxNodes:25});
  assert.equal(layout.nodes.length,25);
  assert.equal(layout.truncated,true);
});
