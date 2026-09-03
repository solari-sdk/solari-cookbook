import dns from "node:dns/promises";
import net from "node:net";

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^fd/i,
];

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  return PRIVATE_RANGES.some((re) => re.test(ip));
}

export interface ValidatedTarget {
  url: URL;
  hostname: string;
  origin: string;
}

export async function validateTargetUrl(raw: string): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Invalid URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are allowed");
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === "localhost") {
    throw new Error("localhost is not allowed");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Private or reserved IP addresses are not allowed");
  } else {
    const records = await dns.lookup(hostname, { all: true });
    for (const { address } of records) {
      if (isPrivateIp(address)) {
        throw new Error(`Hostname resolves to private IP (${address})`);
      }
    }
  }

  return { url, hostname, origin: url.origin };
}

export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
