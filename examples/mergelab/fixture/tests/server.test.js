import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";

function makeApp() {
  const app = express();
  app.get("/api/cart", (_req, res) => {
    res.json({ count: 2 });
  });
  return app;
}

describe("cart api", () => {
  it("returns the item count", async () => {
    const app = makeApp();
    const res = await request(app).get("/api/cart");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});
