export const CASE_FORMAT = 'solari-portable-case';
export const CASE_VERSION = 3;
export const TOOL_VERSION = 'static-console/0.3';
export const DOMAIN_CONTRACT_NAME = 'solari-osint-domain';
export const DOMAIN_CONTRACT_VERSION = 1;
const V2_MEMBER_NAMES = ['events','entities','relationships','evidence','provenance','saved_views'];
const MEMBER_NAMES = [...V2_MEMBER_NAMES,'artifacts','acquisitions','transformations','notes'];
const encoder = new TextEncoder();

export function validateDomainContract(payload) {
  if (!payload || payload.contract !== DOMAIN_CONTRACT_NAME || payload.version !== DOMAIN_CONTRACT_VERSION) throw new Error('Unsupported shared domain contract.');
  if (payload.portable_case?.format !== CASE_FORMAT || payload.portable_case?.version !== CASE_VERSION) throw new Error('Shared domain contract portable-case version does not match this client.');
  for (const name of ['event','source','acquisition','entity','relationship','case','observable']) {
    if (!Array.isArray(payload.models?.[name]?.fields) || !Array.isArray(payload.models?.[name]?.required)) throw new Error(`Shared domain contract is missing ${name}.`);
  }
  return payload;
}

export const DOMAIN_CONTRACT_PROMISE = fetch('./domain-contract.json', { cache: 'no-store' })
  .then(async (response) => {
    if (!response.ok) throw new Error(`domain contract HTTP ${response.status}`);
    return validateDomainContract(await response.json());
  })
  .catch((error) => ({ error: String(error?.message || error) }));

async function sha256Json(value) {
  if (!crypto?.subtle) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))));
  return [...digest].map((byte)=>byte.toString(16).padStart(2,'0')).join('');
}

export async function buildCase(events, extra = {}) {
  const shared = await DOMAIN_CONTRACT_PROMISE;
  if (!shared?.error) validateDomainContract(shared);
  const payload = {
    case: { id: extra.id || crypto.randomUUID(), title: extra.title || 'Portable investigation', notes: extra.case_notes || '', tags: Array.isArray(extra.tags) ? extra.tags : [] },
    events: Array.isArray(events) ? structuredClone(events) : [],
    entities: Array.isArray(extra.entities) ? structuredClone(extra.entities) : [],
    relationships: Array.isArray(extra.relationships) ? structuredClone(extra.relationships) : [],
    evidence: Array.isArray(extra.evidence) ? structuredClone(extra.evidence) : [],
    provenance: Array.isArray(extra.provenance) ? structuredClone(extra.provenance) : [],
    saved_views: Array.isArray(extra.saved_views) ? structuredClone(extra.saved_views) : [],
    artifacts: Array.isArray(extra.artifacts) ? structuredClone(extra.artifacts) : [],
    acquisitions: Array.isArray(extra.acquisitions) ? structuredClone(extra.acquisitions) : [],
    transformations: Array.isArray(extra.transformations) ? structuredClone(extra.transformations) : [],
    notes: Array.isArray(extra.notes) ? structuredClone(extra.notes) : [],
  };
  const files = {};
  for (const name of MEMBER_NAMES) files[`${name}.json`] = await sha256Json(payload[name]);
  const sourceIds = [...new Set(payload.events.map((event)=>event.source_id).filter(Boolean))].sort();
  const transformationIds = payload.transformations.map((item)=>item.id).filter(Boolean).sort();
  return {
    format: CASE_FORMAT, version: CASE_VERSION, exported_at: new Date().toISOString(),
    manifest: {
      schema_version: CASE_VERSION, tool_version: TOOL_VERSION, domain_contract: { name: DOMAIN_CONTRACT_NAME, version: DOMAIN_CONTRACT_VERSION }, created_at: new Date().toISOString(), source_ids: sourceIds,
      transformation_ids: transformationIds, required_capabilities: ['json','sha256'], files,
    },
    ...payload,
  };
}

export async function cloneCaseBundle(data,{id=null,title=null,hypothesisLabel=null}={}) {
  validateCase(data);
  const original=structuredClone(data);
  const cloned=await buildCase(original.events,{
    id:id||crypto.randomUUID(),
    title:title||`${original.case?.title||'Portable investigation'} — branch`,
    case_notes:original.case?.notes||'',
    tags:[...(original.case?.tags||[]),...(hypothesisLabel?[`hypothesis:${hypothesisLabel}`]:[])],
    entities:original.entities||[],relationships:original.relationships||[],evidence:original.evidence||[],provenance:original.provenance||[],saved_views:original.saved_views||[],
    artifacts:original.artifacts||[],acquisitions:original.acquisitions||[],transformations:original.transformations||[],notes:original.notes||[],
  });
  cloned.case.cloned_from=original.case?.id||null;
  cloned.case.hypothesis_label=hypothesisLabel||null;
  cloned.provenance.push({kind:'case-clone',source_case_id:original.case?.id||null,created_at:new Date().toISOString(),hypothesis_label:hypothesisLabel||null});
  cloned.manifest.files['provenance.json']=await sha256Json(cloned.provenance);
  return cloned;
}

export function validateCase(data) {
  if (!data || data.format !== CASE_FORMAT || ![1,2,CASE_VERSION].includes(data.version)) throw new Error('Unsupported portable case format.');
  if (!Array.isArray(data.events)) throw new Error('Portable case is missing events.');
  if (data.events.length > 100000) throw new Error('Portable case exceeds the event safety limit.');
  if (data.version >= 3 && data.manifest?.domain_contract) {
    const domain = data.manifest.domain_contract;
    if (domain.name !== DOMAIN_CONTRACT_NAME || domain.version > DOMAIN_CONTRACT_VERSION) throw new Error('Portable case requires an unsupported shared domain contract.');
  }
  const members=data.version>=3?MEMBER_NAMES.filter((name)=>name!=='events'):V2_MEMBER_NAMES.filter((name)=>name!=='events');
  for (const name of members) {
    if (data[name] != null && !Array.isArray(data[name])) throw new Error(`Portable case ${name} must be an array.`);
    if ((data[name]?.length || 0) > 100000) throw new Error(`Portable case ${name} exceeds the safety limit.`);
  }
  const artifactBytes=(data.artifacts||[]).reduce((sum,item)=>sum+Number(item?.size_bytes||0),0);
  if(artifactBytes>50*1024*1024)throw new Error('Portable case artifact content exceeds the 50 MiB aggregate safety limit.');
  return data;
}

export async function verifyCaseIntegrity(data) {
  validateCase(data);
  if (data.version === 1 || !data.manifest?.files) return { verified: false, legacy: true, mismatches: [] };
  const names=data.version>=3?MEMBER_NAMES:V2_MEMBER_NAMES;
  const mismatches=[];
  for (const name of names) {
    const expected=data.manifest.files[`${name}.json`];
    if (!expected) { mismatches.push(`${name}.json missing checksum`); continue; }
    const actual=await sha256Json(data[name] || []);
    if (actual !== expected) mismatches.push(`${name}.json checksum mismatch`);
  }
  return { verified: mismatches.length === 0, legacy: false, mismatches };
}
