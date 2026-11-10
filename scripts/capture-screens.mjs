/**
 * Captures the console screenshots used in the README. Needs the API and the console running and a
 * local Chrome or Edge.
 *
 *   pnpm screens
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs", "screenshots");
const CONSOLE = process.env.CONSOLE_URL ?? "http://localhost:5180";
const API = process.env.API_URL ?? "http://127.0.0.1:4100";
const VIEWPORT = { width: 1440, height: 900 };

function readEnv(key) {
  const line = fs
    .readFileSync(path.join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} is missing from .env`);
  return line.slice(key.length + 1).replace(/^"|"$/g, "");
}

async function signIn(username) {
  const response = await fetch(`${API}/v1/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, passphrase: readEnv("OPERATOR_PASSPHRASE") }),
  });
  if (!response.ok) throw new Error(`Could not sign in as ${username}`);
  return (await response.json()).token;
}

async function launch() {
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error("Neither Chrome nor Edge could be started");
}

const browser = await launch();
fs.mkdirSync(output, { recursive: true });

/** Opens a page of the console as `username`, or signed out when no username is given. */
async function open(route, username) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1.5, colorScheme: "light" });
  if (username) {
    const token = await signIn(username);
    await context.addInitScript((value) => sessionStorage.setItem("takarail.session", value), token);
  }
  const page = await context.newPage();
  await page.goto(`${CONSOLE}${route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  return page;
}

async function save(page, name, options = {}) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(output, `${name}.png`), ...options });
  console.log(`docs/screenshots/${name}.png`);
  await page.context().close();
}

await save(await open("/"), "sign-in");
await save(await open("/", "supervisor"), "overview", { fullPage: true });
await save(await open("/payments", "admin.surma"), "payments");
await save(await open("/remittances", "compliance"), "remittances");
await save(await open("/reserves", "checker.teesta"), "reserves", { fullPage: true });
await save(await open("/ledger", "auditor"), "ledger");
await save(await open("/reports", "supervisor"), "reports");

const accounts = await open("/directory", "admin.sangu");
await accounts.getByRole("button", { name: "Accounts", exact: true }).click();
await accounts.waitForSelector("tbody tr");
await save(accounts, "directory-accounts");

const payroll = await open("/disbursements", "admin.surma");
await payroll.getByText("PAYROLL-", { exact: false }).first().click();
await payroll.waitForSelector("[role=dialog] tbody tr");
await save(payroll, "disbursement-batch");

const merchants = await open("/directory", "admin.surma");
await merchants.getByRole("button", { name: "Merchants", exact: true }).click();
await merchants.getByRole("button", { name: "QR code" }).first().click();
await merchants.getByPlaceholder("Static code").fill("2450.00");
await merchants.locator("[role=dialog] input").nth(1).fill("INV-2026-000451");
await merchants.getByRole("button", { name: "Generate code" }).click();
await merchants.waitForSelector("[role=dialog] .qr svg");
await save(merchants, "bangla-qr");

await browser.close();
