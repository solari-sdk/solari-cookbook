"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function VerifyWizard() {
  const params = useSearchParams();
  const host = params.get("host") ?? "";
  const [info, setInfo] = useState<{
    token: string;
    dnsRecord: string;
    metaTag: string;
    verified: boolean;
    dns: boolean;
    meta: boolean;
  } | null>(null);
  const [checking, setChecking] = useState(false);

  const load = () => {
    if (!host) return;
    fetch(`/api/verify?host=${encodeURIComponent(host)}`)
      .then((r) => r.json())
      .then(setInfo);
  };

  useEffect(load, [host]);

  const recheck = async () => {
    setChecking(true);
    await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, origin: `https://${host}` }),
    })
      .then((r) => r.json())
      .then((d) => setInfo((i) => (i ? { ...i, ...d, verified: d.verified } : i)));
    setChecking(false);
  };

  if (!host) {
    return (
      <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
        Add <code className="kbd">?host=yourdomain.com</code> to this URL.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Verify {host}</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          Add one of the records below, then re-check.
        </p>
      </div>

      {info?.verified ? (
        <div
          className="mac-card flex items-center gap-3 px-4 py-3 text-[13px]"
          style={{ color: "var(--success)" }}
        >
          <span>✓</span>
          <span>Verified — you can scan this domain now.</span>
        </div>
      ) : (
        <>
          <div className="mac-card p-4">
            <p className="mac-section-label mb-2">Option 1 — DNS TXT</p>
            <code
              className="block overflow-x-auto rounded-md px-3 py-2 font-mono text-[11px]"
              style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)" }}
            >
              {info?.dnsRecord ?? `_solari-scan.${host}`} TXT {info?.token}
            </code>
          </div>
          <div className="mac-card p-4">
            <p className="mac-section-label mb-2">Option 2 — Meta tag</p>
            <code
              className="block overflow-x-auto rounded-md px-3 py-2 font-mono text-[11px]"
              style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)" }}
            >
              {info?.metaTag}
            </code>
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={recheck}
          disabled={checking}
          className="mac-btn-primary px-4 py-2"
        >
          {checking ? "Checking…" : "Re-check verification"}
        </button>
        <Link
          href="/"
          className="text-[13px] transition-opacity hover:opacity-80"
          style={{ color: "var(--accent)" }}
        >
          ← Back to scan
        </Link>
      </div>

      {info && (
        <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
          DNS: {info.dns ? "✓" : "✗"} · Meta: {info.meta ? "✓" : "✗"}
        </p>
      )}
    </div>
  );
}

export default function VerifyPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <Suspense fallback={<p style={{ color: "var(--text-secondary)" }}>Loading…</p>}>
        <VerifyWizard />
      </Suspense>
    </main>
  );
}
