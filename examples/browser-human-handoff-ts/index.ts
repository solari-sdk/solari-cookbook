/**
 * Human handoff — when the agent gets stuck, put a human on it.
 *
 * Some walls a browser agent cannot climb: a 2FA code, a captcha it just
 * failed, a dialog it doesn't understand. `raiseHand()` pauses the agent and
 * puts the live browser session on a phone: a QR code prints in the terminal,
 * you scan it, you see the real page, you fix the one thing, you tap "Hand
 * back", and the agent continues in the same session.
 *
 * The handoff UI itself runs on Solari — raiseHand boots a sandbox, deploys a
 * relay into it, and exposes it through port preview. The same API key that
 * runs this browser runs the escape hatch. Nothing to host, nothing to install
 * on the phone.
 */
import { Solari } from "@solarisdk/browser"
import { raiseHand } from "handraise"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })

const browser = await solari.launch()
try {
  const page = await browser.newPage()

  // A real 2FA wall. Swap it for whatever your agent actually gets stuck on.
  await page.goto("https://github.com/login")

  // ... your agent fills username + password here, then lands on the 2FA page.

  // The agent is stuck. Raise its hand and wait for a human.
  const result = await raiseHand(page, {
    reason: "GitHub is asking for a 2FA code",
    // A QR prints to the terminal by default. onUrl also hands you the link,
    // e.g. to send it to yourself; webhookUrl POSTs it to Slack/Discord/ntfy.
    onUrl: (url) => console.log("handoff:", url),
  })

  console.log("outcome :", result.outcome)
  console.log("waited  :", `${Math.round(result.durationMs / 1000)}s`)

  if (result.outcome === "resolved") {
    // The human solved it; the agent is driving again in the same session.
    // result.storageState holds the cookies the human just earned — persist it
    // to a Solari profile and future runs start already past the wall.
    console.log("signed in — the agent has the session")
  }

  // The other kind of wall: the agent could do the next step, but must not
  // decide it alone. An approval needs no takeover — the human sees one
  // screenshot and the action in words, and answers yes or no on the phone
  // (or in a chat: pass `channels: [telegram({ botToken, chatId })]` from
  // handraise-telegram and the same question arrives there with two buttons).
  const answer = await raiseHand(page, {
    mode: "approval",
    reason: "The agent may not change account settings without a human",
    action: "Save the new notification e-mail address",
  })
  console.log("approval:", answer.outcome) // "approved" | "denied" | "timeout" | "disconnected"
  if (answer.outcome === "approved") {
    // ... the agent clicks Save itself; nothing was injected while it waited.
  }
} finally {
  await browser.close()
  // Required in Node, easy to miss: the browser client keeps a loopback proxy
  // open, so without this the script prints its output and then hangs.
  await solari.close()
}
