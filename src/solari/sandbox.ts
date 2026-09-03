import "dotenv/config";
import { SandboxClient } from "@solarisdk/sandbox";

const apiKey = process.env.SOLARI_API_KEY;

if (!apiKey) {
  throw new Error("SOLARI_API_KEY is missing from .env");
}

export const sandboxClient = new SandboxClient({
  apiKey,
  baseUrl: "https://api.getsolari.com",
});

export async function createSandbox() {
  console.log("📦 Creating Solari sandbox...");

  const sandbox = await sandboxClient.create({
    template: "base",
  });

  console.log("✅ Solari sandbox created");

  return sandbox;
}