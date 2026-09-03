import dns from "node:dns/promises";
import { envBool } from "./env";

export function verificationRequired(): boolean {
  return envBool("REQUIRE_DOMAIN_VERIFY", false);
}

export function verifyToken(hostname: string): string {
  // ponytail: deterministic token from hostname — upgrade to DB-stored random tokens per domain
  return `solari-verify-${Buffer.from(hostname).toString("base64url").slice(0, 24)}`;
}

export function dnsRecordName(hostname: string): string {
  return `_solari-scan.${hostname}`;
}

export async function checkDnsVerification(hostname: string): Promise<boolean> {
  const expected = verifyToken(hostname);
  const name = dnsRecordName(hostname);
  try {
    const records = await dns.resolveTxt(name);
    return records.some((row) => row.join("").includes(expected));
  } catch {
    return false;
  }
}

export async function checkMetaVerification(origin: string, hostname: string): Promise<boolean> {
  const expected = verifyToken(hostname);
  try {
    const res = await fetch(origin, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "SiteScan/1.0" },
    });
    const html = await res.text();
    const re = new RegExp(
      `<meta\\s+name=["']solari-verify["']\\s+content=["']${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
      "i",
    );
    return re.test(html);
  } catch {
    return false;
  }
}

export async function isDomainVerified(hostname: string, origin: string): Promise<boolean> {
  if (!verificationRequired()) return true;
  const [dnsOk, metaOk] = await Promise.all([
    checkDnsVerification(hostname),
    checkMetaVerification(origin, hostname),
  ]);
  return dnsOk || metaOk;
}
