import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { calculateTotal } from "./cart.js";

const PORT = Number(process.env.PORT ?? 3000);

const server = createServer(async (req, res) => {
  if (req.url === "/") {
    const html = await readFile(
      new URL("./index.html", import.meta.url),
      "utf-8"
    );

    res.writeHead(200, {
      "Content-Type": "text/html",
    });

    res.end(html);
    return;
  }

  if (req.url?.startsWith("/api/cart")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    const price = Number(
      url.searchParams.get("price") ?? 0
    );

    const quantity = Number(
      url.searchParams.get("quantity") ?? 1
    );

    const total = calculateTotal(
      price,
      quantity
    );

    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        price,
        quantity,
        total,
      })
    );

    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🛒 Demo app running on port ${PORT}`
  );
});