'use client';

import { useEffect, useState } from 'react';

export interface SolariStatus {
  hasApiKey: boolean;
  liveMode: boolean;
  keyPreview: string | null;
  sdkVersion: string;
}

/**
 * Fetches the (server-side only) status of the Solari API integration.
 * The key itself never leaves the server — only a masked preview.
 */
export function useSolariStatus() {
  const [status, setStatus] = useState<SolariStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/solari/status', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: SolariStatus) => {
        if (!cancelled) {
          setStatus(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { status, loading };
}
