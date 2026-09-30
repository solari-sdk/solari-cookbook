import { createHash, createHmac } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}
