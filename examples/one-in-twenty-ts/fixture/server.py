#!/usr/bin/env python3
"""Tiny checkout fixture server.

GET / and GET /index.html serve the page.
GET /api/shipping?method=express|standard sleeps 250–899ms then returns JSON.
"""
from __future__ import annotations

import json
import random
import time
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 3000
RATES = {"standard": 5, "express": 15}


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/shipping":
            qs = urllib.parse.parse_qs(parsed.query)
            method = (qs.get("method") or ["standard"])[0]
            if method not in RATES:
                self.send_error(400, "unknown shipping method")
                return
            # Same distribution as the old client timer: 250 + floor(random * 650).
            delay_ms = 250 + random.randint(0, 649)
            time.sleep(delay_ms / 1000.0)
            payload = {
                "method": method,
                "cost": RATES[method],
                "delayMs": delay_ms,
            }
            body = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path in ("/", "/index.html"):
            self.path = "/index.html"
        super().do_GET()

    def log_message(self, format: str, *args) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
