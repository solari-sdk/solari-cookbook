export const BACKGROUND_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260808_064556_051587f1-74a1-4336-8c05-4dde3594ed05.mp4";

/**
 * The cinematic backdrop shared by every surface: the same looping video and
 * vignette the landing uses, fixed behind the page so working surfaces can
 * scroll over it.
 *
 * `scrim` darkens it further — the report is dense text and needs the contrast
 * that the landing's sparse hero does not.
 */
export default function VantageBackdrop({ scrim = false }: { scrim?: boolean }) {
  return (
    <div className="backdrop-layer" aria-hidden="true">
      <video
        className="backdrop-video"
        autoPlay
        muted
        loop
        playsInline
        disablePictureInPicture
      >
        <source src={BACKGROUND_VIDEO} type="video/mp4" />
      </video>
      <div className={`backdrop-veil${scrim ? " backdrop-veil-strong" : ""}`} />
    </div>
  );
}
