// SPDX-License-Identifier: AGPL-3.0-only
// What each tool printed when its login command was run in a pty with nothing
// typed into it, escapes taken out, on a wsp machine (gh 2.100.0, gcloud
// 583.0.0, aws-cli 2.36.42, wrangler 4.106.0, vercel 59.15.1, netlify-cli
// 27.5.2, flyctl 0.4.101, supabase 2.117.0, @railway/cli, doppler 3.76.5,
// claude 2.1.263, codex 0.153.0, gemini 0.59.0, cloudflared 2026.8.3) and on a
// Mac for the three the machine has no copy of (opencode 1.18.18, pi 0.84.1,
// hermes 0.20.0). Codes and tokens in these lines are dead: their flows were
// killed before anyone signed in. loginOf beside them is for the tests that
// need the line a row runs without spelling its flags out a second time.
import { hasLogin, signInFor } from "../src/signin-table.js";

export function loginOf(name: string): string {
  const s = signInFor(name);
  if (!hasLogin(s)) throw new Error(`${name} is not a login row`);
  return s.login;
}

export const ASKED = {
  /** Bare, gh stops here and prints no page at all: the bug the fixed flags answer. */
  ghBare: "? Where do you use GitHub?  [Use arrows to move, type to filter]\n> GitHub.com\n  Other\n",
  ghProtocol: "? What is your preferred protocol for Git operations on this host?  [Use arrows to move, type to filter]\n> HTTPS\n  SSH\n",
  ghHow: "? How would you like to authenticate GitHub CLI?  [Use arrows to move, type to filter]\n> Login with a web browser\n  Paste an authentication token\n",
  /** These two are gh's own prompt strings, read out of the binary: one is reachable only with the ssh protocol
   * chosen and the other only once a real sign-in is through, so neither run ended at them here. */
  ghSshKey: "? Upload your SSH public key to your GitHub account?  [Use arrows to move, type to filter]\n",
  ghCredentials: "? Authenticate Git with your GitHub credentials? (Y/n) ",
  /** With the flags: the code, the page, and one Enter to wait on. */
  ghWeb: "! First copy your one-time code: 72F3-072B\nPress Enter to open https://github.com/login/device in your browser... ",
  awsSso: "SSO session name (Recommended): ",
  supabase: "Hello from Supabase! Press Enter to open browser and login automatically.\n│\n◆  \n│  _\n└\n",
  dopplerBare: "Warning: Unable to copy to clipboard\n? Open the authorization page in your browser? (Y/n) ",
  dopplerYes: "Complete authorization at https://dashboard.doppler.com/workplace/auth/cli\nYour auth code is:\narugula_backpack_termite_sea_lannister\n\nWaiting...\n",
  geminiTrust: "Do you trust the files in this folder?\n\nTrusting a folder allows Gemini CLI to load its local configurations.\n\n  1. Trust folder (wsp)\n  2. Trust parent folder (zingzy)\n  3. Don't trust\n",
  geminiAuth: "? Get started\n\n  How would you like to authenticate for this project?\n\n  1. Sign in with Google\n    2. Use Gemini API Key\n    3. Vertex AI\n\n  (Use Enter to select)\n",
  opencode: "└  Add credential\n│\n◆  Select provider\n│  Search: \n│  ◉ OpenCode Zen (recommended)\n│  ◌ Anthropic\n",
  pi: "Trust project folder?\n/Users/zingzy\n\n→ Trust\n  Trust parent folder\n  Do not trust\n",
  hermes: "Credential Pool Status\n==================================================\n\nWhat would you like to do?\n  1. Add a credential\n  2. Remove a credential\n  5. Exit\n\nChoice: ",
} as const;

/** What each tool printed that carries no question: a page, and then the wait for the browser. */
export const REACHED = {
  gcloud:
    "Your browser has been opened to visit:\n\n    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F&scope=openid&state=S&code_challenge=C&code_challenge_method=S256\n\n",
  wrangler:
    "wrangler 4.106.0\nAttempting to login via OAuth...\nOpening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d11594&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Foauth%2Fcallback&scope=account%3Aread&state=S&code_challenge=C&code_challenge_method=S256\n",
  vercel: "Vercel CLI 59.15.1 (Node.js 22.23.2)\n  Visit https://vercel.com/oauth/device?user_code=THHP-TFZS\n\nWaiting for authentication...\n",
  netlify:
    "Logging into your Netlify account...\nOpening https://app.netlify.com/authorize?response_type=ticket&ticket=409f020aa5d8ca8ada30d6bd707c28db\n---------------------------\nError: Unable to open browser automatically: Running inside a docker container\nPlease open your browser and open the URL below:\nhttps://app.netlify.com/authorize?response_type=ticket&ticket=409f020aa5d8ca8ada30d6bd707c28db\n---------------------------\n\nWaiting for authorization...\n",
  fly: "Opening https://fly.io/app/auth/cli/677264753668333275747977363570756b673364346f7a7336707572736a7371 ...\n\npaste code here if prompted > ",
  railway:
    "  Opening your browser to sign in, finish there.\n    https://backboard.railway.com/oauth/auth?response_type=code&client_id=rlwy_oaci_onEklv&redirect_uri=http%3A%2F%2F127.0.0.1%3A33739%2Fcallback&scope=openid+email&code_challenge=C&code_challenge_method=S256&state=S&prompt=consent&cli_caller=tty\n\nWaiting for sign-in...\n",
  claude:
    "Opening browser to sign in...\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile&code_challenge=C&code_challenge_method=S256&state=S\nPaste code here if prompted > ",
  codex:
    "Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid&code_challenge=C&code_challenge_method=S256&state=S&originator=codex_cli_rs\n\nOn a remote or headless machine? Use `codex login --device-auth` instead.\n",
  cloudflared:
    "A browser window should have opened at the following URL:\n\nhttps://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2FRECFCBvzpR0TXfkJ%3D\n\nIf the browser failed to open, please visit the URL above directly in your browser.\n",
} as const;
