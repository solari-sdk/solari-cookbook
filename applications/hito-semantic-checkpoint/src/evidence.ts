import { digest, noAuthority } from './continuity.ts';
export type Primitive = 'SANDBOX' | 'DESKTOP' | 'BROWSER' | 'VOLUME';
export type ObservationType = 'FILE_BYTES' | 'COMMAND_RESULT' | 'SCREENSHOT' | 'DOM' | 'ARTIFACT_RETRIEVAL';
export interface EvidenceEnvelope {
  evidenceId: string; primitiveType: Primitive; workerId: string; sourceIdentity: string;
  observationType: ObservationType; observedAt: string; supportIdentity: string;
  freshness: 'OBSERVED_AT_TIMESTAMP_ONLY'; authority: ReturnType<typeof noAuthority>;
  provenance: 'CALLER_SUPPLIED_ARTIFACT_NOT_PLATFORM_ATTESTATION'; artifactRef: string;
  status: 'OBSERVED';
  resourceId: string; parentCheckpointId?: string;
  artifactIdentity: string; currentness: 'NOT_ESTABLISHED';
}
const allowed: Record<Primitive, ObservationType[]> = { SANDBOX: ['FILE_BYTES', 'COMMAND_RESULT'], DESKTOP: ['SCREENSHOT'], BROWSER: ['DOM'], VOLUME: ['ARTIFACT_RETRIEVAL'] };
type EvidenceMeta = Pick<EvidenceEnvelope, 'primitiveType'|'workerId'|'sourceIdentity'|'observationType'|'observedAt'> & Partial<Pick<EvidenceEnvelope,'resourceId'|'parentCheckpointId'>>;
export function envelope(meta: EvidenceMeta, bytes: Uint8Array): EvidenceEnvelope {
  if (!allowed[meta.primitiveType]?.includes(meta.observationType) || !meta.workerId || !meta.sourceIdentity || !Number.isFinite(Date.parse(meta.observedAt)) || !bytes.length || bytes.length > 4194304) throw Error('EVIDENCE_INVALID');
  const supportIdentity = digest(bytes);
  if (meta.parentCheckpointId !== undefined && !/^[a-f0-9]{64}$/.test(meta.parentCheckpointId)) throw Error('EVIDENCE_PARENT');
  if (meta.resourceId !== undefined && !meta.resourceId) throw Error('EVIDENCE_RESOURCE');
  const body = { primitiveType:meta.primitiveType, workerId:meta.workerId, sourceIdentity:meta.sourceIdentity, observationType:meta.observationType, observedAt:meta.observedAt,
    resourceId:meta.resourceId ?? meta.workerId, ...(meta.parentCheckpointId ? {parentCheckpointId:meta.parentCheckpointId} : {}),
    artifactIdentity:supportIdentity, currentness:'NOT_ESTABLISHED' as const, supportIdentity, freshness: 'OBSERVED_AT_TIMESTAMP_ONLY' as const,
    authority: noAuthority(), provenance: 'CALLER_SUPPLIED_ARTIFACT_NOT_PLATFORM_ATTESTATION' as const,
    artifactRef: 'sha256:' + supportIdentity, status: 'OBSERVED' as const };
  return { ...body, evidenceId: digest(JSON.stringify(body)) };
}
export function validateEvidence(value: EvidenceEnvelope, bytes: Uint8Array) {
  const expected = envelope({ primitiveType: value.primitiveType, workerId: value.workerId, sourceIdentity: value.sourceIdentity, observationType: value.observationType, observedAt: value.observedAt, resourceId:value.resourceId, parentCheckpointId:value.parentCheckpointId }, bytes);
  if (JSON.stringify(expected) !== JSON.stringify(value)) throw Error('EVIDENCE_INTEGRITY_OR_AUTHORITY');
  return expected;
}
export type MergeResult = 'SAFE_UNION'|'CONFLICT_REQUIRES_REOBSERVATION'|'UNKNOWN'|'NO_SAFE_MERGE';
/** Union preserves independent observations. It never produces universal currentness. */
export function mergeEvidence(a: {parentCheckpointId: string; branchId: string; evidence: EvidenceEnvelope[]}, b: typeof a): {status: MergeResult; evidence: EvidenceEnvelope[]; authority: ReturnType<typeof noAuthority>} {
  const result = (status: MergeResult, evidence: EvidenceEnvelope[] = []) => ({ status, evidence: structuredClone(evidence), authority: noAuthority() });
  if (!/^[a-f0-9]{64}$/.test(a.parentCheckpointId) || a.parentCheckpointId !== b.parentCheckpointId || !a.branchId || !b.branchId || a.branchId === b.branchId) return result('NO_SAFE_MERGE');
  if (!a.evidence.length || !b.evidence.length) return result('UNKNOWN');
  for (const e of [...a.evidence,...b.evidence]) {
    const {evidenceId,...body} = e;
    const keys = ['artifactIdentity','artifactRef','authority','currentness','evidenceId','freshness','observationType','observedAt','primitiveType','provenance','resourceId','sourceIdentity','status','supportIdentity','workerId',...(e.parentCheckpointId !== undefined ? ['parentCheckpointId']:[])].sort().join('|');
    if (Object.keys(e).sort().join('|') !== keys || !e.resourceId || e.currentness !== 'NOT_ESTABLISHED' || e.artifactIdentity !== e.supportIdentity ||
        (e.parentCheckpointId !== undefined && e.parentCheckpointId !== a.parentCheckpointId) ||
        !allowed[e.primitiveType]?.includes(e.observationType) || !e.workerId || !e.sourceIdentity || !Number.isFinite(Date.parse(e.observedAt)) ||
        !/^[a-f0-9]{64}$/.test(e.supportIdentity) || e.artifactRef !== 'sha256:' + e.supportIdentity ||
        e.provenance !== 'CALLER_SUPPLIED_ARTIFACT_NOT_PLATFORM_ATTESTATION' ||
        digest(JSON.stringify(body)) !== evidenceId || JSON.stringify(e.authority) !== JSON.stringify(noAuthority()) || e.status !== 'OBSERVED' || e.freshness !== 'OBSERVED_AT_TIMESTAMP_ONLY') return result('NO_SAFE_MERGE');
  }
  const key = (e: EvidenceEnvelope) => [e.primitiveType,e.observationType,e.sourceIdentity].join('|');
  if (new Set(a.evidence.map(key)).size !== a.evidence.length || new Set(b.evidence.map(key)).size !== b.evidence.length) return result('NO_SAFE_MERGE');
  if (a.evidence.some(x => b.evidence.some(y => x.workerId === y.workerId))) return result('NO_SAFE_MERGE');
  if (a.evidence.some(x => b.evidence.some(y => key(x) === key(y) && x.supportIdentity !== y.supportIdentity))) return result('CONFLICT_REQUIRES_REOBSERVATION');
  if (a.evidence.length !== b.evidence.length || a.evidence.some(x => !b.evidence.some(y => key(x) === key(y)))) return result('UNKNOWN');
  return result('SAFE_UNION', [...a.evidence,...b.evidence]);
}
export const semanticLeaseDecision = { verdict: 'KILL', reason: 'Existing bounded currentness and fresh reobservation already provide the proposed validity condition. No new lease ontology.' } as const;
export const reconcileEvidence = mergeEvidence;
