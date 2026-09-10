import { ImageResponse } from "next/og";
import { BRAND_MARK_DATA_URI } from "@/lib/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** iOS home-screen icon: the disc mark on the app's own dark ground. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0b",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={BRAND_MARK_DATA_URI} width={116} height={116} alt="" />
      </div>
    ),
    size,
  );
}
