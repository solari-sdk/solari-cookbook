import type { Sandbox } from '@solarisdk/sandbox';
import { digest } from './continuity.ts';
/** Prototype: caller attaches an existing Solari volume at /evidence first.
 * Successful write alone does not establish persistence across machines. */
export class EvidenceCache {
  private readonly worker: {files:Pick<Sandbox['files'],'read'|'write'>};
  constructor(worker: {files:Pick<Sandbox['files'],'read'|'write'>}) { this.worker = worker; }
  async put(bytes: Uint8Array) {
    if (!bytes.length || bytes.length > 4194304) throw Error('ARTIFACT_LIMIT');
    const sha256 = digest(bytes);
    await this.worker.files.write('/evidence/' + sha256, bytes);
    return { sha256, bytes: bytes.length, artifactRef: 'sha256:' + sha256, persistence: 'UNVERIFIED' as const };
  }
  async get(ref: {sha256: string; bytes: number}) {
    if (!/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > 4194304) throw Error('ARTIFACT_REFERENCE');
    const bytes = await this.worker.files.read('/evidence/' + ref.sha256);
    if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) throw Error('ARTIFACT_INTEGRITY');
    return bytes;
  }
}
