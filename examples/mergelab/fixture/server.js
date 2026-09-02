import express from "express";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(express.static("dist"));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/cart", (_req, res) => {
  res.json({ count: 2 });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
