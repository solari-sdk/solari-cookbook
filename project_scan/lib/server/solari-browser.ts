import { Solari } from "@solarisdk/browser";
import { requireSolariKey } from "./env";

export interface BrowserSession {
  client: Solari;
  browser: Awaited<ReturnType<Solari["launch"]>>;
  sessionId: string;
}

export async function createBrowser(): Promise<BrowserSession> {
  const client = new Solari({
    apiKey: requireSolariKey(),
    baseUrl: "https://api.getsolari.com",
  });
  const browser = await client.launch({ recording: true });
  return { client, browser, sessionId: browser.id };
}

export async function closeBrowser(session: BrowserSession): Promise<string | null> {
  const id = session.sessionId;
  await session.browser.close();
  try {
    const { url } = await session.client.sessions.getReplayUrl(id);
    await session.client.close();
    return url;
  } catch {
    await session.client.close();
    return null;
  }
}
