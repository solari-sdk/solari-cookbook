# Login handoff (TypeScript)

Let a human sign in once, then never ask again.

When an agent hits a login wall, automating a password, a 2FA code and a bot
check is the hard way round. Hand the live session to a person instead: they get
a link, they see the real browser, they sign in, and control returns to the
agent. Save the result to a profile and the next run starts already logged in.

The relay is first-party. The human drives the actual session over a scoped link
that expires, and never sees the signed CDP endpoint.

## Run

```bash
cd examples/browser-login-handoff-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start                            # or: npm start -- https://your-site/login
```

The script prints a URL. Open it yourself to play the human. Sign in, and the
script picks up where it left off and saves the profile. Run it a second time
and it should not ask again.

## The three calls

None of these has an SDK method yet, so the example calls them over HTTP.

| Call | What it does |
| --- | --- |
| `POST /sessions/:id/handoff` | Mints the link. `reason` is required. |
| `GET /sessions/:id/handoff` | `pending`, then `completed` / `cancelled` / `expired`. |
| `POST /sessions/:id/save-profile` | Stores the live session's state into a profile. |

`reason` is not paperwork. It is the sentence the person reads before deciding
whether to trust a link that opens a browser someone else is driving.

Saving through `save-profile` rather than `profiles.save()` matters here: the
gateway reads the state out of the live session, so it captures whatever the
human did, including anything set after the handoff began.

Source: [`index.ts`](index.ts)
