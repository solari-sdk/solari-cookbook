import { migrate } from "@/lib/server/db";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.DATABASE_URL) {
    try {
      await migrate();
    } catch (e) {
      console.warn("DB migrate skipped:", e);
    }
  }
}
