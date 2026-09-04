import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "URL Preview — Solari",
  description: "Paste a URL, get a preview. Runs on Solari infrastructure.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
