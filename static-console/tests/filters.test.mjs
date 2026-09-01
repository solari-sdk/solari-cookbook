import test from 'node:test';
import assert from 'node:assert/strict';

import { applyEventFilters, eventFacets, eventFreshness } from '../filters.js';

const now=Date.parse('2026-09-01T12:00:00Z');
const events=[
  {id:'a',source_id:'s1',category:'earthquake',severity:'high',quality_score:0.9,title:'Alpha quake',observed_at:'2026-09-01T11:30:00Z',latitude:10,longitude:20,properties:{magnitude:5}},
  {id:'b',source_id:'s2',category:'weather',severity:'low',quality_score:0.5,title:'Beta storm',observed_at:'2026-08-30T12:00:00Z',latitude:40,longitude:-70},
];

test('facets and freshness are deterministic',()=>{
  assert.deepEqual(eventFacets(events),{sources:['s1','s2'],categories:['earthquake','weather']});
  assert.equal(eventFreshness(events[0],now).state,'fresh');
  assert.equal(eventFreshness(events[1],now).state,'stale');
});

test('event filters share text facet time quality and geographic state',()=>{
  assert.deepEqual(applyEventFilters(events,{query:'quake',source:'s1',category:'earthquake',severity:'high',min_quality:.8,hours:2,min_lat:0,max_lat:20,min_lon:0,max_lon:30},now).map((event)=>event.id),['a']);
  assert.equal(applyEventFilters(events,{hours:24},now).length,1);
  assert.equal(applyEventFilters(events,{query:'storm',min_quality:.8},now).length,0);
});
