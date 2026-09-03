import {
  checkDnsVerification,
  checkMetaVerification,
  dnsRecordName,
  verificationRequired,
  verifyToken,
} from "@/lib/server/verify";

export async function GET(req: Request) {
  const host = new URL(req.url).searchParams.get("host");
  if (!host) return Response.json({ error: "Missing host" }, { status: 400 });

  const token = verifyToken(host);
  const dns = await checkDnsVerification(host);
  const meta = await checkMetaVerification(`https://${host}`, host);

  return Response.json({
    host,
    required: verificationRequired(),
    verified: dns || meta,
    dns,
    meta,
    token,
    dnsRecord: dnsRecordName(host),
    metaTag: `<meta name="solari-verify" content="${token}" />`,
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { host?: string; origin?: string };
  const host = body.host?.trim();
  if (!host) return Response.json({ error: "Missing host" }, { status: 400 });

  const origin = body.origin ?? `https://${host}`;
  const [dns, meta] = await Promise.all([
    checkDnsVerification(host),
    checkMetaVerification(origin, host),
  ]);

  return Response.json({ verified: dns || meta, dns, meta });
}
