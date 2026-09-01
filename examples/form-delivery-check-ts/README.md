# Form delivery check (TypeScript)

Submit a contact form in a cloud browser, then ask separately whether the lead
actually arrived. A browser and a sandbox working together.

A form can accept a submission, answer 200, and show a thank-you page while the
message goes nowhere. The sandbox here serves two routes that are identical to a
visitor: `/deliver` keeps the lead, `/drop` throws it away and thanks you anyway.
Both print the same confirmation, so only the delivery check separates them.

The sink has to live in the sandbox rather than on your machine. The browser runs
on Solari's infrastructure, so it cannot reach a server on your laptop, and
neither could a real form's backend.

## Run

```bash
cd examples/form-delivery-check-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

```
/deliver  says "Thanks, we got your message" | lead arrived: true
/drop     says "Thanks, we got your message" | lead arrived: false
```

Source: [`index.ts`](index.ts)
