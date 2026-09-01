import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  solariApiKey: required("SOLARI_API_KEY"),
  // This is the real gateway URL for Solari's us-west region, the only
  // region live today. Override it if you are pointed at a staging
  // or self-hosted gateway.
  solariBaseUrl: process.env.SOLARI_BASE_URL ?? "https://api.getsolari.com",
};
