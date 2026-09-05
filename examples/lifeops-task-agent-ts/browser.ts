/**
 * LifeOps Browser Extraction Engine.
 *
 * Automates document discovery, DOM navigation, and structured financial data extraction
 * using Solari Cloud Browsers (`@solarisdk/browser`).
 *
 * Implements strict data validation and deterministic SHA-256 integrity fingerprinting
 * at the untrusted web boundary.
 */

import crypto from "node:crypto";
import type { Page } from "patchright-core";
import type { BrowserSession, Solari } from "@solarisdk/browser";
import { getDemoPortalDataUrl } from "./fixtures.js";
import type { StatementLineItem, StatementPayload, TaskConfig } from "./types.js";

export interface BrowserExtractionOptions {
  /** Enable anti-bot stealth overrides (defaults to false for speed/simplicity) */
  stealth?: boolean;
  /** Regional proxy egress code (e.g. "us"), requires eligible Solari plan */
  proxy?: string;
  /** Navigation timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Normalizes and parses monetary amount strings (e.g. "$148.80", "1,250.50 USD")
 * into valid IEEE-754 numbers rounded to 2 decimal places.
 */
export function parseCurrencyAmount(raw: string): number {
  if (!raw || typeof raw !== "string") {
    throw new Error(`Invalid monetary amount: expected non-empty string, received "${raw}"`);
  }
  const cleaned = raw.replace(/[^0-9.-]+/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") {
    throw new Error(`Cannot parse numeric monetary amount from: "${raw}"`);
  }
  const parsed = parseFloat(cleaned);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
    throw new Error(`Monetary amount resolved to invalid number from: "${raw}"`);
  }
  return Math.round(parsed * 100) / 100;
}

/**
 * Computes a deterministic SHA-256 integrity fingerprint of the normalized statement.
 *
 * IMPORTANT:
 * This hash provides a cryptographic integrity fingerprint of the captured and normalized
 * statement representation. It verifies that downstream consumers (e.g. Sandbox audit VM)
 * receive exact, tamper-evident input. It does NOT certify that the source portal data
 * itself is economically truthful.
 */
export function computeStatementHash(payload: Omit<StatementPayload, "rawHash">): string {
  const canonical = {
    statementId: payload.statementId,
    accountId: payload.accountId,
    billingPeriod: payload.billingPeriod,
    issueDate: payload.issueDate,
    currency: payload.currency,
    totalAmount: payload.totalAmount.toFixed(2),
    lineItems: payload.lineItems.map((item) => ({
      id: item.id,
      description: item.description,
      category: item.category,
      amount: item.amount.toFixed(2),
      unit: item.unit ?? null,
      quantity: item.quantity !== undefined ? item.quantity : null,
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Extracts raw statement metadata and tabular items directly from the active DOM.
 */
async function extractRawFromDOM(page: Page): Promise<{
  statementId: string;
  accountId: string;
  billingPeriod: string;
  issueDate: string;
  currency: string;
  rawTotal: string;
  rawItems: Array<{
    id: string;
    description: string;
    category: string;
    rawAmount: string;
    unit?: string;
    rawQty?: string;
  }>;
}> {
  // Statement-level metadata extraction
  const statementId = (await page.locator('[data-field="statement-id"], #statement-id, .statement-id').first().innerText().catch(() => "")).trim();
  const accountId = (await page.locator('[data-field="account-id"], #account-id, .account-id').first().innerText().catch(() => "")).trim();
  const billingPeriod = (await page.locator('[data-field="billing-period"], #billing-period, .billing-period').first().innerText().catch(() => "")).trim();
  const issueDate = (await page.locator('[data-field="issue-date"], #issue-date, .issue-date').first().innerText().catch(() => "")).trim();
  const currency = (await page.locator('[data-field="currency"], #currency, .currency').first().innerText().catch(() => "USD")).trim();
  const rawTotal = (await page.locator('[data-field="total-amount"], #total-amount, .total-amount, tfoot .total-row td:last-child').first().innerText().catch(() => "")).trim();

  // Tabular item rows extraction
  const rowLocators = page.locator('#billing-statement-table tbody tr, table tbody tr[data-line-item-id]');
  const rowCount = await rowLocators.count();

  const rawItems: Array<{
    id: string;
    description: string;
    category: string;
    rawAmount: string;
    unit?: string;
    rawQty?: string;
  }> = [];

  for (let i = 0; i < rowCount; i++) {
    const row = rowLocators.nth(i);
    const id = (await row.locator('.line-id, td:nth-child(1)').first().innerText().catch(() => "")).trim();
    const description = (await row.locator('.line-desc, td:nth-child(2)').first().innerText().catch(() => "")).trim();
    const category = (await row.locator('.line-cat, td:nth-child(3)').first().innerText().catch(() => "")).trim();
    const rawQty = (await row.locator('.line-qty, td:nth-child(4)').first().innerText().catch(() => "")).trim();
    const unit = (await row.locator('.line-unit, td:nth-child(5)').first().innerText().catch(() => "")).trim();
    const rawAmount = (await row.locator('.line-amount, td:nth-child(6), td:last-child').first().innerText().catch(() => "")).trim();

    rawItems.push({
      id,
      description,
      category,
      rawAmount,
      unit: unit || undefined,
      rawQty: rawQty || undefined,
    });
  }

  return {
    statementId,
    accountId,
    billingPeriod,
    issueDate,
    currency: currency || "USD",
    rawTotal,
    rawItems,
  };
}

/**
 * Validates, normalizes, and checks internal financial consistency of extracted data.
 */
export function validateAndNormalizeStatement(raw: Awaited<ReturnType<typeof extractRawFromDOM>>): Omit<StatementPayload, "rawHash"> {
  if (!raw.statementId) {
    throw new Error("Statement extraction failed: Missing required Statement ID in target portal.");
  }
  if (!raw.accountId) {
    throw new Error("Statement extraction failed: Missing required Account ID in target portal.");
  }
  if (!raw.billingPeriod) {
    throw new Error("Statement extraction failed: Missing required Billing Period in target portal.");
  }
  if (!raw.issueDate) {
    throw new Error("Statement extraction failed: Missing required Issue Date in target portal.");
  }
  if (!raw.rawTotal) {
    throw new Error("Statement extraction failed: Missing required Total Billed Amount in target portal.");
  }
  if (raw.rawItems.length === 0) {
    throw new Error("Statement extraction failed: Target portal table contained 0 billing line items.");
  }

  const totalAmount = parseCurrencyAmount(raw.rawTotal);

  const lineItems: StatementLineItem[] = raw.rawItems.map((item, index) => {
    if (!item.id) {
      throw new Error(`Malformed line item at index ${index}: missing item identifier.`);
    }
    if (!item.description) {
      throw new Error(`Malformed line item [${item.id}]: missing description.`);
    }
    if (!item.category) {
      throw new Error(`Malformed line item [${item.id}]: missing category.`);
    }

    const amount = parseCurrencyAmount(item.rawAmount);
    if (amount < 0) {
      throw new Error(`Malformed line item [${item.id}]: negative monetary amount (${amount}) is not permitted.`);
    }

    let quantity: number | undefined;
    if (item.rawQty) {
      const parsedQty = parseFloat(item.rawQty.replace(/[^0-9.-]+/g, ""));
      if (!Number.isNaN(parsedQty)) {
        quantity = parsedQty;
      }
    }

    return {
      id: item.id,
      description: item.description,
      category: item.category,
      amount,
      unit: item.unit,
      quantity,
    };
  });

  // Boundary verification: verify that the extracted line items sum equals the declared total
  const calculatedSum = Math.round(lineItems.reduce((acc, curr) => acc + curr.amount, 0) * 100) / 100;
  if (Math.abs(calculatedSum - totalAmount) > 0.02) {
    throw new Error(
      `Statement integrity violation: Declared portal total ($${totalAmount.toFixed(2)}) ` +
      `does not match calculated sum of line items ($${calculatedSum.toFixed(2)}).`
    );
  }

  return {
    statementId: raw.statementId,
    accountId: raw.accountId,
    billingPeriod: raw.billingPeriod,
    issueDate: raw.issueDate,
    lineItems,
    totalAmount,
    currency: raw.currency,
  };
}

/**
 * Executes Step 1 of the LifeOps pipeline:
 * Launches a Solari Cloud Browser, navigates to the target billing portal,
 * extracts itemized billing records, normalizes data, and calculates an integrity hash.
 */
export async function acquireStatementViaBrowser(
  config: TaskConfig,
  solari: Solari,
  options: BrowserExtractionOptions = {}
): Promise<StatementPayload> {
  const isDemo = config.targetMode === "demo";
  const targetUrl = isDemo || !config.portalUrl ? getDemoPortalDataUrl() : config.portalUrl;

  console.log(`[Browser Engine] Initializing Solari Cloud Browser session...`);
  console.log(`[Browser Engine] Target mode: ${config.targetMode} (${isDemo ? "Synthetic Portal Fixture" : targetUrl})`);

  let browser: BrowserSession | null = null;
  try {
    // Launch cloud browser session
    // Solari provisions a cloud Chromium microVM and returns a connected Playwright-compatible browser
    browser = await solari.launch({
      stealth: options.stealth ?? false,
      proxy: options.proxy,
    });
    const redactedId = browser.id.slice(0, 16) + "...";
    console.log(`[Browser Engine] Cloud Browser session established (id: ${redactedId})`);

    const page = await browser.newPage();
    console.log(`[Browser Engine] Navigating to billing portal...`);
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs ?? 30_000,
    });

    console.log(`[Browser Engine] Scanning DOM for statement records...`);
    const rawData = await extractRawFromDOM(page);

    console.log(`[Browser Engine] Validating and normalizing ${rawData.rawItems.length} billing rows...`);
    const normalized = validateAndNormalizeStatement(rawData);

    // Cryptographically fingerprint normalized statement
    const rawHash = computeStatementHash(normalized);
    const statement: StatementPayload = {
      ...normalized,
      rawHash,
    };

    console.log(`[Browser Engine] Extraction complete. Integrity SHA-256: ${rawHash}`);
    return statement;
  } finally {
    if (browser) {
      const redactedId = browser.id.slice(0, 16) + "...";
      console.log(`[Browser Engine] Releasing Cloud Browser session (${redactedId})...`);
      await browser.close();
      console.log(`[Browser Engine] Browser session released successfully.`);
    }
  }
}
