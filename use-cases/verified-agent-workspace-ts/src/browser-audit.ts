import { Solari } from "@solarisdk/browser"
import { mkdir } from "node:fs/promises"
import { dirname, relative } from "node:path"
import { sha256File, sha256Text } from "./evidence.js"
import type { BrowserAuditEvidence, BrowserVerifier, ButtonAuditEvidence, TextAuditEvidence, TextExpectation } from "./job-spec.js"

async function withPage<T>(apiKey: string, capabilityUrl: string, route: string, waitForSelector: string, localStorageSeed: Record<string, string> | undefined, fn: (page: any) => Promise<T>): Promise<T> {
  const solari = new Solari({ apiKey })
  const browser = await solari.launch()
  try {
    const page = await browser.newPage()
    if (localStorageSeed && Object.keys(localStorageSeed).length > 0) {
      await page.addInitScript((seed: Record<string, string>) => {
        for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value)
      }, localStorageSeed)
    }
    await page.goto(capabilityUrl, { waitUntil: "networkidle" })
    await page.evaluate((nextRoute: string) => {
      history.pushState({}, "", nextRoute)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }, route)
    await page.waitForSelector(waitForSelector)
    return await fn(page)
  } finally {
    await browser.close()
    await solari.close()
  }
}

async function screenshot(page: any, screenshotPath: string) {
  await mkdir(dirname(screenshotPath), { recursive: true })
  await page.screenshot({ path: screenshotPath, fullPage: true })
  return {
    title: await page.title(),
    screenshotPath: relative(process.cwd(), screenshotPath),
    screenshotSha256: await sha256File(screenshotPath),
  }
}

export async function auditButtons(apiKey: string, capabilityUrl: string, route: string, waitForSelector: string, localStorageSeed: Record<string, string> | undefined, screenshotPath: string): Promise<ButtonAuditEvidence> {
  return withPage(apiKey, capabilityUrl, route, waitForSelector, localStorageSeed, async (page) => {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Accessibility.enable")
    const tree = await cdp.send("Accessibility.getFullAXTree")
    const buttons = tree.nodes.filter((node: any) => node.role?.value === "button")
    const buttonNames = buttons.map((node: any) => typeof node.name?.value === "string" ? node.name.value : "")
    return {
      kind: "button-accessibility",
      buttonCount: buttons.length,
      unnamedButtonCount: buttonNames.filter((name: string) => !name.trim()).length,
      buttonNames,
      ...(await screenshot(page, screenshotPath)),
    }
  })
}

export async function auditText(apiKey: string, capabilityUrl: string, route: string, waitForSelector: string, localStorageSeed: Record<string, string> | undefined, expectation: TextExpectation, screenshotPath: string): Promise<TextAuditEvidence> {
  return withPage(apiKey, capabilityUrl, route, waitForSelector, localStorageSeed, async (page) => {
    const body = await page.locator("body").innerText()
    const checks: TextAuditEvidence["checks"] = []
    if (expectation.mustIncludeText) checks.push({ type: "include", text: expectation.mustIncludeText, passed: body.includes(expectation.mustIncludeText) })
    if (expectation.mustExcludeText) checks.push({ type: "exclude", text: expectation.mustExcludeText, passed: !body.includes(expectation.mustExcludeText) })
    return { kind: "text", bodyTextSha256: sha256Text(body), checks, ...(await screenshot(page, screenshotPath)) }
  })
}

export async function auditBrowser(apiKey: string, capabilityUrl: string, browser: BrowserVerifier, phase: "baseline" | "final", screenshotPath: string): Promise<BrowserAuditEvidence> {
  if (browser.kind === "button-accessibility") return auditButtons(apiKey, capabilityUrl, browser.route, browser.waitForSelector, browser.localStorage, screenshotPath)
  return auditText(apiKey, capabilityUrl, browser.route, browser.waitForSelector, browser.localStorage, browser[phase], screenshotPath)
}
