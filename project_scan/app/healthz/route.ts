import { pingDb } from "@/lib/server/db";

export async function GET() {
  const db = await pingDb();
  return Response.json({ ok: true, db }, { status: db ? 200 : 503 });
}
