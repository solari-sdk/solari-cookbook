import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCase, cloneCaseBundle, verifyCaseIntegrity } from '../schema.js';
import { encryptCase, decryptCase } from '../crypto.js';
import { scanForSecrets } from '../security.js';
import { caseCsv, caseGeoJson, caseGraphMl, caseGraphSnapshotSvg, caseReportHtml } from '../exports.js';

const event={id:'e1',source_id:'fixture',source_record_id:'1',category:'test',title:'Example',observed_at:'2026-09-01T00:00:00Z',latitude:1,longitude:2,quality_score:1};

test('portable case manifest verifies and detects tampering',async()=>{
  const bundle=await buildCase([event],{id:'case-1',title:'Fixture'});
  assert.equal((await verifyCaseIntegrity(bundle)).verified,true);
  bundle.events[0].title='Changed';
  assert.equal((await verifyCaseIntegrity(bundle)).verified,false);
});

test('encrypted portable case round trips',async()=>{
  const bundle=await buildCase([event],{id:'case-1'});
  const encrypted=await encryptCase(bundle,'correct horse battery staple');
  const decrypted=await decryptCase(encrypted,'correct horse battery staple');
  assert.equal(decrypted.case.id,'case-1');
  await assert.rejects(()=>decryptCase(encrypted,'incorrect password value'),/Unable to decrypt case/);
});

test('portable case cloning branches without mutating original',async()=>{
  const bundle=await buildCase([event],{id:'case-1',title:'Fixture',notes:[{id:'n1',body:'Evidence note'}]});
  const clone=await cloneCaseBundle(bundle,{id:'case-2',title:'Alternate',hypothesisLabel:'alternate'});
  assert.equal(bundle.case.id,'case-1');
  assert.equal(bundle.case.hypothesis_label,undefined);
  assert.equal(clone.case.id,'case-2');
  assert.equal(clone.case.cloned_from,'case-1');
  assert.equal(clone.case.hypothesis_label,'alternate');
  assert.equal(clone.notes[0].body,'Evidence note');
  assert.equal((await verifyCaseIntegrity(clone)).verified,true);
});

test('secret scanner blocks credential-shaped fields',()=>{
  assert.equal(scanForSecrets({api_key:'placeholder-but-nonempty'}).length,1);
  assert.equal(scanForSecrets({quality_score:1,title:'safe'}).length,0);
});

test('derivative exports and graph snapshot are generated from one case',async()=>{
  const bundle=await buildCase([event],{id:'case-1',title:'Fixture <Case>',entities:[{id:'a',label:'A'},{id:'b',label:'B'}],relationships:[{id:'r',source_entity_id:'a',target_entity_id:'b',type:'related'}]});
  assert.match(caseCsv(bundle),/Example/);
  assert.deepEqual(caseGeoJson(bundle).features[0].geometry.coordinates,[2,1]);
  assert.match(caseGraphMl(bundle),/<edge id="r" source="a" target="b"\/>/);
  const graph=caseGraphSnapshotSvg(bundle);
  assert.match(graph,/aria-label="Case relationship graph snapshot"/);
  assert.match(graph,/<line /);
  const report=caseReportHtml(bundle);
  assert.match(report,/<h2>Timeline<\/h2>/);
  assert.match(report,/Relationship graph snapshot/);
  assert.match(report,/Reproducibility manifest/);
  assert.match(report,/Fixture &lt;Case&gt;/);
  assert.doesNotMatch(report,/<script/i);
});
