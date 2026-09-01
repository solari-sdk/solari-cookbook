import { putMany } from './storage.js';

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder();

function toHex(bytes) { return [...bytes].map((byte)=>byte.toString(16).padStart(2,'0')).join(''); }
function bytesToBase64(bytes) {
  let binary='';
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  return btoa(binary);
}
function base64ToBytes(value) {
  const binary=atob(value); const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes;
}

export async function sha256Bytes(bytes) {
  if (!crypto?.subtle) throw new Error('Web Crypto is required for content-addressed artifacts.');
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function artifactFromBytes(bytes, { originalName=null, mimeType='application/octet-stream', tags=[], caseId=null, provenance={} } = {}) {
  const normalized=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  if(normalized.byteLength>MAX_ARTIFACT_BYTES)throw new Error('Artifact exceeds 10 MiB browser safety limit.');
  const digest=await sha256Bytes(normalized);
  return {
    id:digest,sha256:digest,size_bytes:normalized.byteLength,mime_type:mimeType||'application/octet-stream',original_name:originalName,
    tags:[...new Set((tags||[]).map((tag)=>String(tag).trim()).filter(Boolean))].sort(),case_id:caseId,created_at:new Date().toISOString(),
    provenance:structuredClone(provenance||{}),bytes_b64:bytesToBase64(normalized),
  };
}

export async function artifactFromFile(file, options={}) {
  if(!file || typeof file.arrayBuffer!=='function')throw new Error('A readable browser File is required.');
  if(file.size>MAX_ARTIFACT_BYTES)throw new Error('Artifact exceeds 10 MiB browser safety limit.');
  return artifactFromBytes(new Uint8Array(await file.arrayBuffer()),{...options,originalName:options.originalName??file.name,mimeType:options.mimeType??file.type??'application/octet-stream'});
}

export async function artifactFromText(text, options={}) {
  return artifactFromBytes(encoder.encode(String(text)),{...options,mimeType:options.mimeType||'text/plain;charset=utf-8'});
}

export async function storeArtifact(record) { await putMany('artifacts',[record]); return record; }
export function artifactBlob(record) { return new Blob([base64ToBytes(record.bytes_b64||'')],{type:record.mime_type||'application/octet-stream'}); }
