export const CASE_FORMAT = 'solari-portable-case';
export const CASE_VERSION = 1;

export function buildCase(events, extra = {}) {
  return {
    format: CASE_FORMAT,
    version: CASE_VERSION,
    exported_at: new Date().toISOString(),
    case: {
      id: extra.id || crypto.randomUUID(),
      title: extra.title || 'Portable investigation',
      notes: extra.notes || '',
      tags: Array.isArray(extra.tags) ? extra.tags : [],
    },
    events,
    entities: Array.isArray(extra.entities) ? extra.entities : [],
    relationships: Array.isArray(extra.relationships) ? extra.relationships : [],
    evidence: Array.isArray(extra.evidence) ? extra.evidence : [],
    provenance: Array.isArray(extra.provenance) ? extra.provenance : [],
    saved_views: Array.isArray(extra.saved_views) ? extra.saved_views : [],
  };
}

export function validateCase(data) {
  if (!data || data.format !== CASE_FORMAT || data.version !== CASE_VERSION) throw new Error('Unsupported portable case format.');
  if (!Array.isArray(data.events)) throw new Error('Portable case is missing events.');
  if (data.events.length > 100000) throw new Error('Portable case exceeds the event safety limit.');
  return data;
}
