/** Explicit future live entry. Never invoked on import or by npm test/demo. */
import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {StretchHarness} from './stretch-harness.ts';
import type {Source} from './continuity.ts';
import {officialClients} from './stretch-resources.ts';
import type {ResourceRecord} from './stretch-resources.ts';

export function attemptStore(directory:string) {
  mkdirSync(directory,{recursive:true});
  return {
    claimAttempt() {
      writeFileSync(join(directory,'STRETCH_LIVE_ATTEMPT.lock'),JSON.stringify({kind:'HITO_STRETCH_R2',createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
    },
    persist(records:ResourceRecord[]) {
      const next=join(directory,'resource-ledger.next.json');
      writeFileSync(next,JSON.stringify(records,null,2),{mode:0o600});
      renameSync(next,join(directory,'resource-ledger.json'));
    },
  };
}
/** A later operator must authorize execution and select one fixed output
 * directory for the attempt. Existing lock is never removed or retried. */
export async function runLiveStretch(key:string,source:Source,changed:Source,directory:string,volume:'enabled'|'disabled'='enabled') {
  const store=attemptStore(directory);
  const clients=officialClients(key,volume);
  try {
    const report=await new StretchHarness().run(clients,source,changed,{qualification:'LIVE',volume,...store});
    const artifacts=report.artifacts.map(({sha256,bytes})=>{
      const filename=sha256+'.bin';
      writeFileSync(join(directory,filename),bytes,{mode:0o600});
      return {sha256,bytes:bytes.length,file:filename};
    });
    writeFileSync(join(directory,'stretch-result.json'),JSON.stringify({...report,artifacts},null,2),{mode:0o600});
    return report;
  } finally {await clients.browser.close();}
}
