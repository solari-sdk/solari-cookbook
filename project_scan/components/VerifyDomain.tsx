"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export function VerifyDomain({ hostname }: { hostname: string }) {
  const [info, setInfo] = useState<{
    token: string;
    dnsRecord: string;
    metaTag: string;
    verified: boolean;
    required: boolean;
  } | null>(null);

  useEffect(() => {
    fetch(`/api/verify?host=${encodeURIComponent(hostname)}`)
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {});
  }, [hostname]);

  if (!info || !info.required) return null;

  if (info.verified) {
    return (
      <div
        className="mac-card flex items-center gap-3 px-4 py-3 text-[13px]"
        style={{ color: "var(--success)" }}
      >
        <span>✓</span>
        <span>Domain verified — ready to scan.</span>
      </div>
    );
  }

  return (
    <div className="mac-card space-y-3 p-4">
      <div>
        <p className="text-[13px] font-semibold" style={{ color: "var(--warning)" }}>
          Domain verification required
        </p>
        <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          Prove you control <strong style={{ color: "var(--text-primary)" }}>{hostname}</strong> before scanning.
        </p>
      </div>
      <div>
        <p className="mac-section-label mb-1.5">DNS TXT record</p>
        <code
          className="block overflow-x-auto rounded-md px-3 py-2 font-mono text-[11px]"
          style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)" }}
        >
          {info.dnsRecord} → {info.token}
        </code>
      </div>
      <div>
        <p className="mac-section-label mb-1.5">Meta tag</p>
        <code
          className="block overflow-x-auto rounded-md px-3 py-2 font-mono text-[11px]"
          style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)" }}
        >
          {info.metaTag}
        </code>
      </div>
      <Link
        href={`/verify?host=${encodeURIComponent(hostname)}`}
        className="text-[13px] transition-opacity hover:opacity-80"
        style={{ color: "var(--accent)" }}
      >
        Open verification wizard →
      </Link>
    </div>
  );
}
