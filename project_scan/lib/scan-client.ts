import type { ScanEvent } from "@/lib/types";

export function startScan(
  url: string,
  onEvent: (event: ScanEvent) => void,
  onError?: (err: Error) => void,
): () => void {
  const params = new URLSearchParams({ url });
  const es = new EventSource(`/api/scan?${params}`);

  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as ScanEvent);
    } catch {
      // ignore parse errors
    }
  };

  es.onerror = () => {
    onError?.(new Error("Scan connection lost"));
    es.close();
  };

  return () => es.close();
}
