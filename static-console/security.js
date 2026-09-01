const SECRET_KEY = /(^|_)(api_?key|access_?token|refresh_?token|authorization|password|passwd|cookie|session_?token|private_?key|client_?secret)($|_)/i;
const SECRET_VALUE = /\b(Bearer\s+[A-Za-z0-9._~+\/-]{12,}|sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b/;

export function scanForSecrets(value, path = '$', findings = []) {
  if (Array.isArray(value)) value.forEach((item, index) => scanForSecrets(item, `${path}[${index}]`, findings));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (SECRET_KEY.test(key) && child != null && String(child).trim()) findings.push(`${childPath}: secret-like field`);
      scanForSecrets(child, childPath, findings);
    }
  } else if (typeof value === 'string' && SECRET_VALUE.test(value)) findings.push(`${path}: secret-like value`);
  return [...new Set(findings)].slice(0, 25);
}

export function assertSafeExport(value) {
  const findings = scanForSecrets(value);
  if (findings.length) throw new Error(`Export blocked by secret/session scan (${findings.length} finding(s)).`);
}
