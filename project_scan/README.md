# SiteScan

Pre-production security scanner for staging URLs. Runs passive checks, browser crawl, and nuclei in [Solari](https://docs.getsolari.com/) sandboxes, then an OpenRouter AI agent reviews findings before you ship.

## Quick start

```sh
cp .env.example .env
# Add SOLARI_API_KEY (required) and OPENROUTER_API_KEY (optional)

# With Docker (Postgres + app)
docker compose up --build

# Or local dev (Postgres optional — scans work without DB persistence)
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), paste a staging URL, and scan.

## API keys

| Key | Required | Where |
|-----|----------|-------|
| `SOLARI_API_KEY` | Yes | [console.getsolari.com](https://console.getsolari.com) |
| `OPENROUTER_API_KEY` | No | [openrouter.ai/keys](https://openrouter.ai/keys) — falls back to deterministic scoring |

## Environment

See [`.env.example`](.env.example). Key flags:

- `REQUIRE_DOMAIN_VERIFY=false` — skip DNS/meta verification (dev default)
- `REQUIRE_DOMAIN_VERIFY=true` — require domain proof before scanning (SaaS mode)
- `MAX_CRAWL_PAGES=50` — browser crawl limit

## Domain verification

When `REQUIRE_DOMAIN_VERIFY=true`, prove domain control via:

- **DNS TXT**: `_solari-scan.example.com` → `solari-verify-…`
- **Meta tag**: `<meta name="solari-verify" content="…" />`

Wizard at `/verify?host=example.com`.

## Scan pipeline

1. **Passive** — TLS, security headers, nuclei (sandbox)
2. **Crawl** — cookies, mixed content, secrets, forms (Solari browser)
3. **AI review** — OpenRouter agent investigates and submits PASS/WARN/FAIL

Results stream over SSE and persist at `/s/{scan-id}`.

## Routes

| Route | Purpose |
|-------|---------|
| `/` | Start a scan |
| `/s/{scan-id}` | Shareable report |
| `/verify` | Domain verification wizard |
| `/api/scan?url=` | SSE scan stream |
| `/healthz` | Health + DB ping |

## Self-host

```sh
cp .env.example .env
docker compose up -d --build
```

App listens on port 3000. Set `ORIGIN` to your public URL for link previews.
