import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));
const index=await readFile(resolve(here,'../index.html'),'utf8');
const app=await readFile(resolve(here,'../app.js'),'utf8');
const serverRuntime=await readFile(resolve(here,'../server-runtime.js'),'utf8');

test('every static app and runtime-adapter id selector has a matching HTML element',()=>{
  const ids=[...`${app}\n${serverRuntime}`.matchAll(/querySelector\(['"]#([A-Za-z0-9_-]+)['"]\)/g)].map((match)=>match[1]);
  assert.ok(ids.length>20);
  for(const id of new Set(ids))assert.match(index,new RegExp(`id=["']${id}["']`),`missing #${id}`);
});

test('core interactive surfaces expose basic accessible labels or native labels',()=>{
  assert.match(index,/canvas id="world-map"[^>]+aria-label=/);
  assert.match(index,/<label>Search <input id="filter-query"/);
  assert.match(index,/id="runtime-status" aria-live="polite"/);
  assert.match(index,/id="import-preview" aria-live="polite"/);
  assert.doesNotMatch(index,/<script(?![^>]+type="module"[^>]+src=)[^>]*>/i);
});
