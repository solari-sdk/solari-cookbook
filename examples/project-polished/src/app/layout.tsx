import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Project Polished — Autonomous UI/UX Agent · Solari SDK",
  description:
    "Drop a GitHub repo. The Solari-powered agent sandboxes it, drives a headless browser, audits the UI with a vision model, then drives VS Code to ship a polished PR. Built for the Solari SDK bounty.",
  keywords: [
    "Solari",
    "Solari SDK",
    "autonomous agent",
    "UI UX agent",
    "AI agent",
    "browser automation",
    "desktop automation",
    "Next.js",
    "vision model",
  ],
  authors: [{ name: "Project Polished" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Project Polished — Autonomous UI/UX Agent",
    description:
      "Solari-powered autonomous agent that sandboxes a repo, audits the UI with a vision model, then writes surgical fixes via desktop automation.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Project Polished — Autonomous UI/UX Agent",
    description:
      "Solari-powered agent: sandbox → browser → vision → VS Code → PR. @harrychow_ @getsolari",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
