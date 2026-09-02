import type { Page } from "patchright-core";

export default async function verify({ page, baseUrl }: { page: Page; baseUrl: string }) {
  await page.goto(baseUrl);
  await page.waitForSelector("#cart", { timeout: 10_000 });
  const cartText = await page.locator("#cart").innerText();
  if (!cartText.includes("Cart: 2")) {
    throw new Error(`Expected cart to show 'Cart: 2', got: ${cartText}`);
  }

  // PR B adds the checkout UI.
  const checkout = page.locator("#checkout");
  if (await checkout.isVisible().catch(() => false)) {
    const checkoutText = await checkout.innerText();
    if (!checkoutText.includes("Checkout items: 2")) {
      throw new Error(`Expected checkout to show 'Checkout items: 2', got: ${checkoutText}`);
    }
  }
}
