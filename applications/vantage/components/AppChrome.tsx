import Link from "next/link";
import VantageBackdrop from "./VantageBackdrop";

function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 25 25" role="img" aria-hidden="true">
      <defs>
        <clipPath id="chrome-disc">
          <circle cx="12.5" cy="12.5" r="12.5" />
        </clipPath>
      </defs>
      <g clipPath="url(#chrome-disc)">
        <rect width="25" height="25" fill="#ededed" />
        <path d="M12.5 0 L20 12.5 L12.5 25 L5 12.5 Z" fill="#050606" />
        <path d="M12.5 3.5 L17.4 12.5 L12.5 21.5 L7.6 12.5 Z" fill="#737778" />
        <path d="M12.5 6.5 L15.2 12.5 L12.5 18.5 L9.8 12.5 Z" fill="#fafafa" />
        <path d="M12.5 9.5 L13.8 12.5 L12.5 15.5 L11.2 12.5 Z" fill="#0a0b0b" />
      </g>
    </svg>
  );
}

/**
 * Chrome for the working surfaces (report, settings): the same backdrop video,
 * fonts, and glass language as the landing, but scrollable and behind a
 * heavier scrim so dense text stays readable.
 */
export default function AppChrome({ children }: { children: React.ReactNode }) {
  return (
    <>
      <VantageBackdrop scrim />
      <div className="over-backdrop flex min-h-screen flex-col">
        <header className="glass-bar sticky top-0 z-20">
          <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-6">
            <Link
              href="/"
              className="flex items-center gap-2.5"
              aria-label="Vantage home"
            >
              <BrandMark />
              <span className="text-[15px] tracking-tight text-foreground">
                Vantage
              </span>
            </Link>
            <nav className="flex items-center gap-5">
              <Link
                href="/"
                className="text-[15px] text-[rgba(229,229,230,0.77)] transition-colors hover:text-foreground"
              >
                Home
              </Link>
              <Link
                href="/settings"
                className="text-[15px] text-[rgba(229,229,230,0.77)] transition-colors hover:text-foreground"
              >
                Settings
              </Link>
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-white/10">
          <div className="mx-auto w-full max-w-5xl px-6 py-5">
            <p className="font-mono text-[11px] text-faint">
              Public sources only. Every claim is grounded in the scrape — check
              &ldquo;not established&rdquo; before acting on a gap.
            </p>
          </div>
        </footer>
      </div>
    </>
  );
}
