import "dotenv/config";
import { Solari } from "@solarisdk/browser";

const apiKey = process.env.SOLARI_API_KEY;

if (!apiKey) {
  throw new Error("SOLARI_API_KEY is missing from .env");
}

export const solari = new Solari({
  apiKey,
  baseUrl: "https://api.getsolari.com",
});

export interface BrowserVerificationResult {
  verified: boolean;
  quantity: number;
  expected: string;
  actual: string;
}

export async function reproduceCartBug(
  url: string
): Promise<BrowserVerificationResult> {
  console.log("🌐 Opening application in Solari Browser...");

  const browser = await solari.launch();

  try {
    const page = await browser.newPage();

    await page.goto(url);

    console.log("✅ Page loaded");

    const title = await page.title();
    console.log(`📄 Page title: ${title}`);

    await page.locator("#quantity").fill("3");

    console.log("🛒 Quantity set to 3");

    await page.locator("#calculate").click();

    console.log("🖱️ Calculate button clicked");

    const result = await page.locator("#result").innerText();

    console.log(`📊 Browser result: ${result}`);

    const expected = "$30";

    if (result !== expected) {
      console.log("🐛 BUG REPRODUCED");
      console.log(`Expected: ${expected}`);
      console.log(`Actual:   ${result}`);

      return {
        verified: false,
        quantity: 3,
        expected,
        actual: result,
      };
    }

    console.log("🎉 FIX VERIFIED");
    console.log(`Expected: ${expected}`);
    console.log(`Actual:   ${result}`);

    return {
      verified: true,
      quantity: 3,
      expected,
      actual: result,
    };
  } finally {
    await browser.close();
  }
}