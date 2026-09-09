/**
 * An ordinary Playwright spec. Nothing here knows about Solari — the only
 * change from a suite you already have is the import on the next line, which
 * would normally read `from "@playwright/test"`.
 */
import { test, expect } from "./solari"

test("reads a page in a cloud browser", async ({ page }) => {
  await page.goto("https://example.com")
  await expect(page).toHaveTitle(/Example Domain/)
  await expect(page.locator("h1")).toHaveText("Example Domain")
})

test("keeps state across tests in the same file", async ({ page }) => {
  // Same session, same context, so the previous test's cookies and storage are
  // still here. That is different from local Playwright, which gives each test
  // a fresh context — worth knowing before you port a suite that relies on it.
  await page.goto("https://example.com/?second=1")
  expect(new URL(page.url()).searchParams.get("second")).toBe("1")
})
