import { ImageResponse } from "next/og";
import { BRAND_MARK_DATA_URI, SITE_NAME } from "@/lib/brand";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Vantage — know your competition before they know themselves";

/**
 * The card shown when a link is shared. Generated rather than a screenshot so
 * it stays legible at the small sizes Slack and X render it at.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "linear-gradient(140deg, #101114 0%, #08090b 55%, #0d0a09 100%)",
          color: "#e8eaed",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={BRAND_MARK_DATA_URI} width={44} height={44} alt="" />
          <div style={{ display: "flex", fontSize: 30, letterSpacing: -0.5 }}>
            {SITE_NAME}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 68, lineHeight: 1.08, letterSpacing: -2 }}>
            Know your competition.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 68,
              lineHeight: 1.08,
              letterSpacing: -2,
              color: "rgba(255,255,255,0.55)",
            }}
          >
            Before they know themselves.
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontSize: 26,
              lineHeight: 1.4,
              color: "rgba(226,229,228,0.72)",
              maxWidth: 900,
            }}
          >
            Drop a URL. An agent browses, researches, and delivers a full
            competitive teardown in under 60 seconds.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 21 }}>
          <div style={{ display: "flex", width: 34, height: 2, background: "#6e9eff" }} />
          <div style={{ display: "flex", color: "rgba(226,229,228,0.6)" }}>
            Solari · Claude · OpenAI · Gemini
          </div>
        </div>
      </div>
    ),
    size,
  );
}
