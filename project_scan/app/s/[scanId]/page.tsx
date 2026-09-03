import { ScanApp } from "@/components/ScanApp";
import { getScan } from "@/lib/server/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

export async function generateMetadata(props: PageProps<"/s/[scanId]">): Promise<Metadata> {
  const { scanId } = await props.params;
  try {
    const scan = await getScan(scanId);
    if (!scan) return { title: "Scan not found" };
    return {
      title: `${scan.verdict.toUpperCase()} — ${scan.hostname}`,
      description: scan.summary,
    };
  } catch {
    return { title: "SiteScan Report" };
  }
}

export default async function SharePage(props: PageProps<"/s/[scanId]">) {
  const { scanId } = await props.params;
  let scan = null;
  try {
    scan = await getScan(scanId);
  } catch {
    // DB unavailable
  }
  if (!scan) notFound();
  return <ScanApp initialUrl={scan.url} initialScan={scan} />;
}
