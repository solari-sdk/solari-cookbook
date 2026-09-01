export const CASE_FORMAT = 'solari-portable-case';
export const CASE_VERSION = 2;
export const TOOL_VERSION = 'static-console/0.2';
const MEMBER_NAMES = ['events','entities','relationships','evidence','provenance','saved_views'];
const encoder = new TextEncoder();

async function sha256Json(value) {
  if (!crypto?.subtle) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))));
  return [...digest].map((byte)=>byte.toString(16).padStart(2,'0')).join('');
}

export async function buildCase(events, extra = {}) {
  const payload = {
    case: { id: extra.id || crypto.randomUUID(), title: extra.title || 'Portable investigation', notes: extra.notes || '', tags: Array.isArray(extra.tags) ? extra.tags : [] },
    events: Array.isArray(events) ? events : [], entities: Array.isArray(extra.entities) ? extra.entities : [],
    relationships: Array.isArray(extra.relationships) ? extra.relationships : [], evidence: Array.isArray(extra.evidence) ? extra.evidence : [],
    provenance: Array.isArray(extra.provenance) ? extra.provenance : [], saved_views: Array.isArray(extra.saved_views) ? extra.saved_views : [],
  };
  const files = {};
  for (const name of MEMBER_NAMES) files[`${name}.json`] = await sha256Json(payload[name]);
  const sourceIds = [...new Set(payload.events.map((event)=>event.source_id).filter(Boolean))].sort();
  return {
    format: CASE_FORMAT, version: CASE_VERSION, exported_at: new Date().toISOString(),
    manifest: { schema_version: CASE_VERSION, tool_version: TOOL_VERSION, created_at: new Date().toISOString(), source_ids: sourceIds, required_capabilities: ['json'], files },
    ...payload,
  };
}

export function validateCase(data) {
  if (!data || data.format !== CASE_FORMAT || ![1, CASE_VERSION].includes(data.version)) throw new Error('Unsupported portable case format.');
  if (!Array.isArray(data.events)) throw new Error('Portable case is missing events.');
  if (data.events.length > 100000) throw new Error('Portable case exceeds the event safety limit.');
  for (const name of ['entities','relationships','evidence','provenance','saved_views']) {
    if (data[name] != null && !Array.isArray(data[name])) throw new Error(`Portable case ${name} must be an array.`);
    if ((data[name]?.length || 0) > 100000) throw new Error(`Portable case ${name} exceeds the safety limit.`);
  }
  return data;
}

export async function verifyCaseIntegrity(data) {
  validateCase(data);
  if (data.version === 1 || !data.manifest?.files) return { verified: false, legacy: true, mismatches: [] };
  const mismatches=[];
  for (const name of MEMBER_NAMES) {
    const expected=data.manifest.files[`${name}.json`];
    if (!expected) { mismatches.push(`${name}.json missing checksum`); continue; }
    const actual=await sha256Json(data[name] || []);
    if (actual !== expected) mismatches.push(`${name}.json checksum mismatch`);
  }
  return { verified: mismatches.length === 0, legacy: false, mismatches };
}
