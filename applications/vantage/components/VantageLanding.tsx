"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PROVIDERS, isLlmProvider } from "@/lib/providers";
import { readTimezoneLabel } from "@/lib/timezone";
import {
  ACTIVE_RUN_KEY,
  MODEL_STORAGE_KEY,
  PROVIDER_STORAGE_KEY,
  apiKeyStorageKey,
} from "@/lib/storage-keys";
import { BACKGROUND_VIDEO } from "./VantageBackdrop";
import "@/app/vantage.css";

/**
 * Abstract red/blue smoke, embedded so the card never depends on a missing
 * binary. Swap in /assets/watch-demo-thumbnail.png if you have the original.
 */
const DEMO_THUMBNAIL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <defs>
        <radialGradient id="r" cx="32%" cy="34%" r="62%">
          <stop offset="0%" stop-color="#ff5a4a" stop-opacity=".92"/>
          <stop offset="45%" stop-color="#a52218" stop-opacity=".55"/>
          <stop offset="100%" stop-color="#12080a" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="b" cx="70%" cy="70%" r="60%">
          <stop offset="0%" stop-color="#4f7dff" stop-opacity=".85"/>
          <stop offset="48%" stop-color="#1b3aa0" stop-opacity=".5"/>
          <stop offset="100%" stop-color="#070c18" stop-opacity="0"/>
        </radialGradient>
        <filter id="s"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3"/>
          <feColorMatrix type="saturate" values="0"/>
          <feComponentTransfer><feFuncA type="linear" slope=".08"/></feComponentTransfer>
        </filter>
      </defs>
      <rect width="400" height="400" fill="#0b1116"/>
      <rect width="400" height="400" fill="url(#r)"/>
      <rect width="400" height="400" fill="url(#b)"/>
      <rect width="400" height="400" filter="url(#s)"/>
    </svg>`,
  );

const NAV_LINKS = [
  { label: "Home", href: "/", active: true, external: false },
  { label: "Settings", href: "/settings", active: false, external: false },
  {
    label: "vaibhavkothari.me",
    href: "https://vaibhavkothari.me",
    active: false,
    external: true,
  },
];

/**
 * The walkthrough clip is ~10MB, so it is not vendored into this repository.
 * It is served from the project's own repository instead; the panel simply
 * stays empty if the fetch fails, which costs the landing nothing.
 */
const DEMO_VIDEO =
  "https://raw.githubusercontent.com/vaibhavkothari33/Vantage/main/public/demo.mp4";

/**
 * One-click examples. Each was verified end to end: homepage, pricing, and
 * about all load, the searches return on-topic results, and Hacker News plus
 * GitHub both resolve — so a demo run has real material to work with.
 */
const EXAMPLES = [
  { host: "vercel.com", note: "funding + breaches" },
  { host: "cal.com", note: "open source pivot" },
  { host: "posthog.com", note: "pricing + community" },
  { host: "supabase.com", note: "open source Firebase" },
];

/**
 * A ticking clock as an external store. Reading the time in `getSnapshot`
 * rather than in an effect keeps the component render pure — the server
 * snapshot is `null`, so nothing renders until the client has mounted and
 * there is no hydration mismatch.
 */
function subscribeToClock(onChange: () => void): () => void {
  const id = setInterval(onChange, 1_000);
  return () => clearInterval(id);
}

function readClockSecond(): number {
  return Math.floor(Date.now() / 1_000);
}

function readServerClock(): null {
  return null;
}

const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** Matches the breakpoints where the hamburger replaces the inline nav. */
const COMPACT_QUERY =
  "(max-width: 790px), (max-width: 1100px) and (orientation: portrait)";

function readActiveRun(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_RUN_KEY);
  } catch {
    return null;
  }
}

/** The provider/key/model the user configured on /settings. */
function readCredentials(): { provider: string; apiKey: string; model: string } | null {
  try {
    const stored = sessionStorage.getItem(PROVIDER_STORAGE_KEY);
    const provider = isLlmProvider(stored) ? stored : PROVIDERS[0].id;
    const apiKey = sessionStorage.getItem(apiKeyStorageKey(provider)) ?? "";
    if (!apiKey) return null;
    const info = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
    return {
      provider,
      apiKey,
      model: sessionStorage.getItem(MODEL_STORAGE_KEY) || info.defaultModel,
    };
  } catch {
    return null;
  }
}

export default function VantageLanding() {
  const router = useRouter();
  const headerRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [isCompact, setIsCompact] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoPaused, setDemoPaused] = useState(false);
  const demoVideoRef = useRef<HTMLVideoElement>(null);
  const [target, setTarget] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRun = useSyncExternalStore(subscribeToStorage, readActiveRun, () => null);

  // Live local time. `null` on the server, so the panel renders a placeholder
  // until the client mounts rather than shipping a stale timestamp.
  const clockSecond = useSyncExternalStore(
    subscribeToClock,
    readClockSecond,
    readServerClock,
  );
  const clock =
    clockSecond === null
      ? null
      : (() => {
          const now = new Date(clockSecond * 1_000);
          return { time: TIME_FORMAT.format(now), date: DATE_FORMAT.format(now) };
        })();
  // City and country both come from the IANA zone, so they can never disagree.
  const timezone = clockSecond === null ? "Timezone" : readTimezoneLabel().label;

  // The nav is only hidden behind the toggle at the compact breakpoints, so
  // that is the only place it should be inert when closed.
  useEffect(() => {
    const query = window.matchMedia(COMPACT_QUERY);
    const sync = () => setIsCompact(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Full-viewport composition: no page scroll while this route is mounted.
  useEffect(() => {
    document.documentElement.classList.add("vantage-lock");
    return () => document.documentElement.classList.remove("vantage-lock");
  }, []);

  // One-shot entrance. `motion-pending` is removed when the last element
  // (the demo card) finishes, with a fallback in case animationend never fires.
  useEffect(() => {
    const root = document.documentElement;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    root.classList.add("motion-pending");
    const fallback = window.setTimeout(
      () => root.classList.remove("motion-pending"),
      3500,
    );
    const card = cardRef.current;
    const done = () => {
      window.clearTimeout(fallback);
      root.classList.remove("motion-pending");
    };
    card?.addEventListener("animationend", done);

    return () => {
      window.clearTimeout(fallback);
      card?.removeEventListener("animationend", done);
      root.classList.remove("motion-pending");
    };
  }, []);

  // Escape closes the demo modal.
  useEffect(() => {
    if (!demoOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDemoOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [demoOpen]);

  // Escape and outside pointer close the tablet/mobile menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    headerRef.current?.querySelector<HTMLAnchorElement>(".nav a")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [menuOpen]);

  function toggleDemoPlayback() {
    const video = demoVideoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {
        // Autoplay policy refused an unmuted play; the overlay button stays up.
      });
    } else {
      video.pause();
    }
  }

  async function start(explicitUrl?: string, demo = false) {
    if (submitting || activeRun) return;
    const url = (explicitUrl ?? target).trim();
    if (!url) {
      setError("Enter a competitor URL first.");
      return;
    }
    // Reflect the example in the field so it is obvious what is running.
    if (explicitUrl) setTarget(explicitUrl);

    // A demo prefers a cached replay, which needs no key — but send any
    // configured credentials anyway so a host without a saved run can just
    // fall through to a live one.
    const credentials = readCredentials();
    if (!demo && !credentials) {
      setError("No model key set yet — open Settings to add one.");
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, demo, ...(credentials ?? {}) }),
      });
      const data = (await response.json()) as {
        id?: string;
        error?: string;
        runId?: string;
      };

      if (!response.ok || !data.id) {
        if (response.status === 429 && data.runId) {
          try {
            sessionStorage.setItem(ACTIVE_RUN_KEY, data.runId);
          } catch {}
        }
        setError(data.error ?? "Could not start the agent.");
        setSubmitting(false);
        return;
      }

      try {
        sessionStorage.setItem(ACTIVE_RUN_KEY, data.id);
      } catch {}
      router.push(`/report/${data.id}`);
    } catch {
      setError("Network error — is the server still running?");
      setSubmitting(false);
    }
  }

  return (
    <main className="viewport">
      <section className="screen" id="screen">
        <video
          className="background"
          autoPlay
          muted
          loop
          playsInline
          disablePictureInPicture
          aria-hidden="true"
        >
          <source src={BACKGROUND_VIDEO} type="video/mp4" />
        </video>

        <header
          ref={headerRef}
          className={`header${menuOpen ? " menu-open" : ""}`}
        >
          <Link className="brand" href="/" aria-label="Vantage home">
            <BrandMark />
          </Link>

          <div
            className="header-actions"
            id="tablet-navigation"
            inert={isCompact && !menuOpen}
          >
            <nav className="nav">
              {NAV_LINKS.map((link) =>
                link.external ? (
                  <a
                    key={link.label}
                    href={link.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="nav-external"
                    onClick={() => setMenuOpen(false)}
                  >
                    {link.label}
                    <ExternalIcon />
                  </a>
                ) : (
                  <Link
                    key={link.label}
                    href={link.href}
                    className={link.active ? "active" : undefined}
                    aria-current={link.active ? "page" : undefined}
                    onClick={() => setMenuOpen(false)}
                  >
                    {link.label}
                  </Link>
                ),
              )}
            </nav>

            <div className="time-panel">
              <span className="label">{timezone}</span>
              <span className="value">
                {clock ? (
                  <>
                    {clock.time}&nbsp; • &nbsp;{clock.date}
                  </>
                ) : (
                  <span className="clock-placeholder" />
                )}
              </span>
            </div>

            <button
              type="button"
              className="sign-up"
              onClick={() => router.push("/settings")}
            >
              Settings
            </button>
          </div>

          <button
            type="button"
            className="menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="tablet-navigation"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MenuIcon open={menuOpen} />
          </button>
        </header>

        <section className="hero">
          <div className="hero-content">
            <h1 className="hero-title">
              <span className="line line-one">
                <span className="line-reveal">Know Your Competition.</span>
              </span>
              <span className="line line-two">
                <span className="line-reveal">Before They Know Themselves.</span>
              </span>
            </h1>

            <p className="hero-copy">
              Drop a URL. Our agent browses, researches, and delivers{" "}
              <br />
              a full competitive teardown in under 60 seconds.
            </p>

            <div className="hero-target">
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void start();
                }}
                disabled={submitting || activeRun !== null}
                spellCheck={false}
                autoComplete="off"
                placeholder="https://competitor.com"
                aria-label="Competitor URL"
              />
            </div>

            <button
              type="button"
              className="primary-cta"
              onClick={() => void start()}
              disabled={submitting || activeRun !== null}
            >
              <span className="label">
                {submitting ? "Starting…" : "Run Agent →"}
              </span>
            </button>

            <div className="hero-examples">
              <span className="hero-examples-label">Try these examples: </span>
              {EXAMPLES.map((example) => (
                <Link
                  key={example.host}
                  href={`/demo/${example.host}`}
                  className="hero-example"
                  title={`Replay a saved teardown of ${example.host} — ${example.note}`}
                >
                  {example.host}
                </Link>
              ))}
            </div>

            <p className={`hero-status${error ? " is-error" : ""}`}>
              {error ? (
                error.includes("Settings") ? (
                  <>
                    {error} <Link href="/settings">Open settings →</Link>
                  </>
                ) : (
                  error
                )
              ) : activeRun ? (
                <>
                  A run is already in progress.{" "}
                  <Link href={`/report/${activeRun}`}>Watch it →</Link>
                </>
              ) : (
                <>
                  Uses your own model key.{" "}
                  <Link href="/settings">Settings →</Link>
                </>
              )}
            </p>
          </div>

          <article className="demo-card" ref={cardRef}>
            <div className="demo-visual">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={DEMO_THUMBNAIL} alt="Abstract red and blue smoke" />
              <button
                type="button"
                className="play"
                aria-label="Play demo"
                onClick={() => setDemoOpen(true)}
              >
                <PlayIcon />
              </button>
            </div>
            <button
              type="button"
              className="watch-button"
              onClick={() => setDemoOpen(true)}
            >
              Watch Demo
            </button>
          </article>
        </section>

        {demoOpen && (
          <div
            className="demo-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Product demo"
            onClick={(event) => {
              if (event.target === event.currentTarget) setDemoOpen(false);
            }}
          >
            {/* The panel hugs the video exactly, so anything outside the
                frame is the overlay and closes the modal. */}
            <div className="demo-modal-panel">
              <video
                ref={demoVideoRef}
                src={DEMO_VIDEO}
                autoPlay
                loop
                playsInline
                preload="metadata"
                onClick={toggleDemoPlayback}
                onPlay={() => setDemoPaused(false)}
                onPause={() => setDemoPaused(true)}
              />
              {demoPaused && (
                <button
                  type="button"
                  className="demo-modal-play"
                  aria-label="Play demo"
                  onClick={toggleDemoPlayback}
                >
                  <PlayIcon />
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

/* ---------------------------------------------------------------- */

function BrandMark() {
  return (
    <svg width="25" height="25" viewBox="0 0 25 25" role="img" aria-hidden="true">
      <defs>
        <clipPath id="vantage-disc">
          <circle cx="12.5" cy="12.5" r="12.5" />
        </clipPath>
      </defs>
      <g clipPath="url(#vantage-disc)">
        <rect width="25" height="25" fill="#ededed" />
        <path d="M12.5 0 L20 12.5 L12.5 25 L5 12.5 Z" fill="#050606" />
        <path d="M12.5 3.5 L17.4 12.5 L12.5 21.5 L7.6 12.5 Z" fill="#737778" />
        <path d="M12.5 6.5 L15.2 12.5 L12.5 18.5 L9.8 12.5 Z" fill="#fafafa" />
        <path d="M12.5 9.5 L13.8 12.5 L12.5 15.5 L11.2 12.5 Z" fill="#0a0b0b" />
      </g>
    </svg>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <line
        x1="3"
        y1={open ? "10" : "7"}
        x2="17"
        y2={open ? "10" : "7"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        transform={open ? "rotate(45 10 10)" : undefined}
      />
      <line
        x1="3"
        y1={open ? "10" : "13"}
        x2="17"
        y2={open ? "10" : "13"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        transform={open ? "rotate(-45 10 10)" : undefined}
      />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        d="M4.4 7.6 L7.9 4.1 M4.9 4.1 H7.9 V7.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.6 7.4 V9.2 A1.1 1.1 0 0 1 8.5 10.3 H2.8 A1.1 1.1 0 0 1 1.7 9.2 V3.5 A1.1 1.1 0 0 1 2.8 2.4 H4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.75"
      />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true">
      <path d="M2 1.5 L12.5 8 L2 14.5 Z" fill="#fff" />
    </svg>
  );
}
