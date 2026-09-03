import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SiteScan — Pre-production security scanner",
  description: "Scan staging sites for real-world vulnerabilities before you ship, powered by Solari.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
