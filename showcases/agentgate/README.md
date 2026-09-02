# AgentGate

AgentGate is a public observability tool for seeing which isolated browser
configurations can reach a webpage. It compares plain headless access, Web Bot
Auth, stealth, and managed proxy egress, then publishes the evidence and measured
cost in a permanent server-rendered report.

- [Try AgentGate](https://tryagentgate.fly.dev)
- [Source and deployment guide](https://github.com/dibyo10/agentgate)
- [Methodology](https://tryagentgate.fly.dev/methodology)
- [Solari engineering notes](https://github.com/dibyo10/agentgate/blob/main/docs/SOLARI-NOTES.md)

## Run the CLI

Requires Node 20+ and a [Solari API key](https://console.getsolari.com).

```bash
git clone https://github.com/dibyo10/agentgate.git
cd agentgate
npm ci
export SOLARI_API_KEY=slr_live_...
npx tsx src/cli.ts example.com
```

Add `--deep` for the full seven-configuration matrix, a fresh control render,
geo comparison, and one conditional captcha-solving attempt.

## What the project demonstrates

- Every configuration gets a fresh Solari session and every session is released
  on success, failure, retry, and shutdown paths.
- Web Bot Auth is ranked ahead of stealth so the report distinguishes honest
  agent access from disguised access.
- Transfer bytes and score components are nullable. Unmeasured values contribute
  zero earned and zero possible points instead of becoming estimated facts.
- PostgreSQL stores durable reports and session leases, Redis and BullMQ enforce
  queueing and credit ceilings, and Cloudflare R2 stores screenshots and report
  artifacts.
- Permanent reports and Open Graph cards are fully rendered without client-side
  JavaScript.

The production app runs one API process and one long-running worker on Fly.io.
Its repository includes the test matrices, phase-gate reports, deployment
runbook, and an honest log of the Solari API behavior encountered in production.
