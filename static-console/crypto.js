const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function deriveKey(passphrase, salt, iterations = 250000) {
  if (!passphrase || passphrase.length < 10) throw new Error('Passphrase must be at least 10 characters.');
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptCase(caseData, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plaintext = encoder.encode(JSON.stringify(caseData));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  return {
    format: 'solari-encrypted-case',
    version: 1,
    algorithm: 'AES-GCM-256',
    kdf: 'PBKDF2-SHA256',
    iterations: 250000,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function decryptCase(bundle, passphrase) {
  if (!bundle || bundle.format !== 'solari-encrypted-case' || bundle.version !== 1) throw new Error('Unsupported encrypted case format.');
  const salt = base64ToBytes(bundle.salt);
  const iv = base64ToBytes(bundle.iv);
  const ciphertext = base64ToBytes(bundle.ciphertext);
  const key = await deriveKey(passphrase, salt, bundle.iterations || 250000);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('Unable to decrypt case. Check the passphrase or file integrity.');
  }
}
