/**
 * Reference scenario: one business week on the network, played through the same API the console
 * uses. Institutions are funded against the reserve, customers pay merchants and each other,
 * exchange houses send remittances, a garment factory runs its payroll and an allowance batch waits
 * for approval. Compliance, maker-checker and reconciliation steps happen where they would in a day.
 *
 *   pnpm scenario
 *
 * On a local node the script places each transaction at its own time of day, so the week ends at the
 * present. The run is reproducible: the same chain state gives the same week.
 */
import { formatDecimal, parseTaka } from "@takarail/sdk";

import { config } from "../src/config";

const API = `http://${config.http.host}:${config.http.port}`;
const HOUR = 3_600;
const DAY = 24 * HOUR;
const DHAKA_UTC_OFFSET = 6 * HOUR;
const DAYS_IN_SCENARIO = 7;

// ------------------------------------------------------------------ helpers

/** Small seeded generator, so every run plays the same week. */
function createRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    between: (min: number, max: number) => min + next() * (max - min),
    integer: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (probability: number) => next() < probability,
  };
}

const random = createRandom(2026_11_10);

const taka = (amount: number | string) => parseTaka(typeof amount === "number" ? amount.toFixed(2) : amount);
const decimal = (poisha: bigint) => formatDecimal(poisha, 2);
const crore = (amount: number) => taka(amount * 10_000_000);
const lakh = (amount: number) => taka(amount * 100_000);

/** Random amount between two taka values, rounded to `step` taka. */
const amountBetween = (min: number, max: number, step = 5) =>
  taka(Math.max(step, Math.round(random.between(min, max) / step) * step));

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(config.chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const sessions = new Map<string, string>();

async function request<T>(token: string | undefined, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: { code: string; message: string } };
  if (!response.ok) {
    throw new ApiError(response.status, payload.error?.code ?? "ERROR", payload.error?.message ?? response.statusText);
  }
  return payload;
}

/** Calls the API as `username`, signing in on first use. */
async function as<T = { txHash: string }>(username: string, method: "GET" | "POST", path: string, body?: unknown) {
  let token = sessions.get(username);
  if (!token) {
    const session = await request<{ token: string }>(undefined, "POST", "/v1/auth/sign-in", {
      username,
      passphrase: config.auth.operatorPassphrase,
    });
    token = session.token;
    sessions.set(username, token);
  }
  return request<T>(token, method, path, body);
}

// ------------------------------------------------------------------ directory

interface Account {
  address: string;
  label: string;
  institutionId: string;
  tier: string;
}

interface Directory {
  accounts: Account[];
  byLabel(label: string): Account;
  people: Account[];
  workers: Account[];
}

const ADMIN: Record<string, string> = {
  TEESTA: "admin.teesta",
  SURMA: "admin.surma",
  HALDA: "admin.halda",
  SANGU: "admin.sangu",
  DHOW: "ops.dhow",
  NAJD: "ops.najd",
  SELAT: "ops.selat",
  HUDSON: "ops.hudson",
  TREASURY: "treasury",
};

const PEOPLE = [
  "Rahima Begum",
  "Abdul Karim",
  "Nusrat Jahan",
  "Tanvir Ahmed",
  "Shirin Akter",
  "Mizanur Rahman",
  "Fatema Khatun",
  "Jahangir Alam",
  "Sultana Parvin",
  "Rafiqul Islam",
  "Ayesha Siddiqua",
  "Kamal Hossain",
];

const FACTORY = "Shitalakshya Knitwear Ltd.";
const ALLOWANCE_OFFICE = "Social Allowance Programme Office";

async function loadDirectory(): Promise<Directory> {
  const accounts = await as<Account[]>("ops.network", "GET", "/v1/accounts?limit=200");
  const byLabel = (label: string) => {
    const account = accounts.find((item) => item.label === label);
    if (!account) throw new Error(`No account is labelled "${label}"`);
    return account;
  };
  const people = PEOPLE.map(byLabel);
  const workers = accounts.filter(
    (account) => account.tier === "Basic" && !PEOPLE.includes(account.label) && account.label !== null,
  );
  return { accounts, byLabel, people, workers };
}

/** Balances the scenario expects, kept locally so it only submits payments that can settle. */
const balances = new Map<string, bigint>();
const balanceOf = (address: string) => balances.get(address) ?? 0n;
const credit = (address: string, amount: bigint) => balances.set(address, balanceOf(address) + amount);
const debit = (address: string, amount: bigint) => balances.set(address, balanceOf(address) - amount);

const BASIC_PER_TRANSACTION = taka(25_000);
const BASIC_MAX_BALANCE = taka(300_000);

// ------------------------------------------------------------------ calendar

interface Step {
  at: number;
  label: string;
  run: () => Promise<unknown>;
}

interface BusinessDay {
  index: number;
  date: string;
  opens: number;
  closes: number;
}

const dhakaMidnight = (timestamp: number) => Math.floor((timestamp + DHAKA_UTC_OFFSET) / DAY) * DAY - DHAKA_UTC_OFFSET;

/** Business days from the day after the chain's clock up to today, at most a week. */
async function planCalendar(): Promise<BusinessDay[]> {
  const head = await rpc<string>("eth_blockNumber");
  const block = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [head, false]);
  const chainNow = Number(BigInt(block.timestamp));
  const wallNow = Math.floor(Date.now() / 1000) - 5 * 60;
  const today = dhakaMidnight(wallNow);

  const days: BusinessDay[] = [];
  for (let offset = DAYS_IN_SCENARIO - 1; offset >= 0; offset -= 1) {
    const midnight = today - offset * DAY;
    const opens = Math.max(midnight + 9 * HOUR, chainNow + 60);
    const closes = Math.min(midnight + 20 * HOUR, wallNow);
    if (closes - opens < 2 * HOUR) continue;
    days.push({
      index: days.length,
      date: new Date((midnight + DHAKA_UTC_OFFSET) * 1000).toISOString().slice(0, 10),
      opens,
      closes,
    });
  }
  if (days.length === 0) throw new Error("The chain clock leaves no room for a business day before now");
  return days;
}

/** Moves the node's clock so the next transaction is mined at its place in the day. */
class Clock {
  private last = 0;
  private adjustable = true;

  async moveTo(timestamp: number): Promise<void> {
    if (!this.adjustable) return;
    this.last = Math.max(timestamp, this.last + 1);
    try {
      await rpc("evm_setNextBlockTimestamp", [this.last]);
    } catch {
      // A network that keeps its own time: the scenario plays at the pace of the chain.
      this.adjustable = false;
    }
  }

  /** Brings the node back to the present, so what happens next carries the real time. */
  async returnToPresent(): Promise<void> {
    if (!this.adjustable) return;
    const now = Math.floor(Date.now() / 1000);
    if (now > this.last) await rpc("evm_mine", [now]);
  }
}

// ------------------------------------------------------------------ the week

const RATES: Record<string, { username: string; originator: string; rate: number; currency: string }> = {
  "AE-BD": { username: "ops.dhow", originator: "DHOW", rate: 33.33, currency: "AED" },
  "SA-BD": { username: "ops.najd", originator: "NAJD", rate: 32.63, currency: "SAR" },
  "MY-BD": { username: "ops.selat", originator: "SELAT", rate: 28.95, currency: "MYR" },
  "US-BD": { username: "ops.hudson", originator: "HUDSON", rate: 122.4, currency: "USD" },
};

const MERCHANTS = [
  { id: "BHORER-01", min: 350, max: 4_500, weight: 5 },
  { id: "SHAPLA-01", min: 120, max: 2_200, weight: 3 },
  { id: "RUPSHA-01", min: 40, max: 350, weight: 5 },
  { id: "JATRA-01", min: 180, max: 1_400, weight: 3 },
  { id: "NAKSHI-01", min: 800, max: 9_500, weight: 2 },
  { id: "DHANSHIRI-01", min: 1_500, max: 14_000, weight: 1 },
];
const MERCHANT_WHEEL = MERCHANTS.flatMap((merchant) => Array<typeof merchant>(merchant.weight).fill(merchant));

const ISSUANCE: [string, bigint][] = [
  ["SURMA", crore(8)],
  ["HALDA", crore(5)],
  ["SANGU", crore(6)],
  ["DHOW", crore(5)],
  ["NAJD", crore(5)],
  ["SELAT", crore(2)],
  ["HUDSON", crore(4)],
  ["TREASURY", crore(1)],
];

/** Returned by a step that chose not to submit anything. */
const SKIPPED = Symbol("skipped");

const stats = { played: 0, skipped: 0 };
let issued = 0n;
let sequence = 0;
const nextRef = (prefix: string, day: BusinessDay) =>
  `${prefix}-${day.date.replace(/-/g, "")}-${String((sequence += 1)).padStart(4, "0")}`;

function buildWeek(days: BusinessDay[], directory: Directory): Step[] {
  const steps: Step[] = [];
  const { people, workers, byLabel } = directory;
  const factory = byLabel(FACTORY);
  const allowanceOffice = byLabel(ALLOWANCE_OFFICE);
  const lastDay = days[days.length - 1] as BusinessDay;

  const add = (at: number, label: string, run: () => Promise<unknown>) => steps.push({ at, label, run });
  const during = (day: BusinessDay) => Math.floor(random.between(day.opens + 50 * 60, day.closes - 10 * 60));

  /** Issuance through maker and checker. */
  const issue = (at: number, day: BusinessDay, institution: string, amount: bigint) => {
    add(at, `issuance requested for ${institution}`, async () => {
      await as("maker.teesta", "POST", "/v1/reserves/issuance", {
        institution,
        amount: decimal(amount),
        fundingRef: nextRef(`RTGS-${institution}`, day),
      });
      issued += amount;
    });
    add(at + 12 * 60, `issuance approved for ${institution}`, async () => {
      const reserves = await as<{ issuance: { id: string; status: string; institutionId: string }[] }>(
        "checker.teesta",
        "GET",
        "/v1/reserves",
      );
      const pending = reserves.issuance.find((item) => item.status === "Pending" && item.institutionId === institution);
      if (!pending) throw new Error(`No pending issuance for ${institution}`);
      await as("checker.teesta", "POST", `/v1/reserves/issuance/${pending.id}/approve`);
    });
  };

  const cashIn = (at: number, account: Account, amount: bigint) =>
    add(at, `cash-in ${account.label}`, async () => {
      await as(ADMIN[account.institutionId] as string, "POST", `/v1/accounts/${account.address}/cash-in`, {
        amount: decimal(amount),
      });
      credit(account.address, amount);
    });

  const remit = (
    at: number,
    day: BusinessDay,
    corridor: string,
    beneficiary: Account,
    sourceAmount: number,
    held = false,
  ) => {
    const route = RATES[corridor] as (typeof RATES)[string];
    add(at, `remittance ${corridor} to ${beneficiary.label}`, async () => {
      const quote = await as<{ amount: string; incentive: string }>(
        route.username,
        "GET",
        `/v1/remittances/quote?corridor=${corridor}&sourceAmount=${sourceAmount.toFixed(2)}`,
      );
      const received = BigInt(quote.amount) + BigInt(quote.incentive);
      if (beneficiary.tier === "Basic" && balanceOf(beneficiary.address) + received > BASIC_MAX_BALANCE) {
        return SKIPPED;
      }
      await as(route.username, "POST", "/v1/remittances", {
        corridor,
        beneficiary: beneficiary.address,
        sourceAmount: sourceAmount.toFixed(2),
        purpose: random.pick(["FAMI", "FAMI", "FAMI", "EDUC", "MDCS", "SAVG"]),
        senderRef: nextRef(route.originator, day),
      });
      if (!held) credit(beneficiary.address, received);
    });
  };

  /** Finds the remittance under review for `beneficiary` and applies a compliance decision. */
  const decide = (at: number, beneficiary: Account, decision: "release" | "reject", reason?: string) =>
    add(at, `remittance ${decision} for ${beneficiary.label}`, async () => {
      const held = await as<{ id: string; beneficiary: string; amount: string; incentive: string }[]>(
        "compliance",
        "GET",
        "/v1/remittances?status=UnderReview",
      );
      const remittance = held.find((item) => item.beneficiary === beneficiary.address);
      if (!remittance) throw new Error(`No remittance under review for ${beneficiary.label}`);
      await as("compliance", "POST", `/v1/remittances/${remittance.id}/${decision}`, reason ? { reason } : undefined);
      if (decision === "release") credit(beneficiary.address, BigInt(remittance.amount));
    });

  for (const day of days) {
    const isFirst = day.index === 0;
    const morning = day.opens;

    // Opening of the day: reserve statement and reference rates.
    const plannedIssuance = isFirst
      ? ISSUANCE.reduce((sum, [, amount]) => sum + amount, 0n)
      : day.index === 3
        ? crore(2)
        : day.index === 5
          ? crore(3)
          : day === lastDay
            ? crore(1)
            : 0n;
    add(morning, "reserve statement", async () => {
      await as("auditor", "POST", "/v1/reserves/statements", {
        balance: decimal(issued + plannedIssuance + lakh(50)),
        document: `Teesta trust account statement ${day.date}`,
      });
    });
    Object.entries(RATES).forEach(([corridor, route], position) => {
      route.rate = Number((route.rate * (1 + random.between(-0.0025, 0.003))).toFixed(4));
      const rate = route.rate.toFixed(4);
      add(morning + (4 + position) * 60, `rate ${corridor}`, () =>
        as("maker.teesta", "POST", `/v1/corridors/${corridor}/rate`, { rate }),
      );
    });

    if (isFirst) {
      ISSUANCE.forEach(([institution, amount], position) =>
        issue(morning + (9 + position) * 60, day, institution, amount),
      );
      add(morning + 32 * 60, "incentive pool funded", () =>
        as("treasury", "POST", "/v1/remittances/incentive-pool", { amount: decimal(lakh(80)) }),
      );
      people.forEach((person, position) =>
        cashIn(
          morning + (34 + position) * 60,
          person,
          person.tier === "Full" ? amountBetween(45_000, 140_000, 500) : amountBetween(6_000, 22_000, 100),
        ),
      );
      cashIn(morning + 47 * 60, factory, lakh(8));
      cashIn(morning + 48 * 60, allowanceOffice, lakh(3));
    }
    if (day.index === 3) issue(morning + 10 * 60, day, "SANGU", crore(2));
    if (day.index === 5) issue(morning + 10 * 60, day, "SURMA", crore(3));

    // Retail payments. Volume grows a little through the week.
    const merchantPayments = 11 + day.index + random.integer(0, 4);
    for (let count = 0; count < merchantPayments; count += 1) {
      const merchant = random.pick(MERCHANT_WHEEL);
      const payer = random.pick(people);
      const amount = amountBetween(merchant.min, merchant.max);
      const invoiceRef = random.chance(0.4) ? nextRef("INV", day).slice(0, 25) : undefined;
      add(during(day), `payment to ${merchant.id}`, async () => {
        const overLimit = payer.tier === "Basic" && amount > BASIC_PER_TRANSACTION;
        if (overLimit || balanceOf(payer.address) < amount) {
          stats.skipped += 1;
          return;
        }
        await as(ADMIN[payer.institutionId] as string, "POST", "/v1/payments/merchant", {
          payer: payer.address,
          merchantId: merchant.id,
          amount: decimal(amount),
          invoiceRef,
        });
        debit(payer.address, amount);
      });
    }

    const transfers = 3 + random.integer(0, 3);
    for (let count = 0; count < transfers; count += 1) {
      const payer = random.pick(people);
      const payee = random.pick(people.filter((person) => person !== payer));
      const amount = amountBetween(300, 9_000, 50);
      add(during(day), `transfer ${payer.label} to ${payee.label}`, async () => {
        const capped = payee.tier === "Basic" && balanceOf(payee.address) + amount > BASIC_MAX_BALANCE;
        if (capped || balanceOf(payer.address) < amount) {
          stats.skipped += 1;
          return;
        }
        await as(ADMIN[payer.institutionId] as string, "POST", "/v1/payments/transfer", {
          payer: payer.address,
          payee: payee.address,
          amount: decimal(amount),
          reference: nextRef("E2E", day),
          purpose: random.pick(["FAMI", "FAMI", "EDUC", "OTHR"]),
        });
        debit(payer.address, amount);
        credit(payee.address, amount);
      });
    }

    // Remittances from the four corridors. Basic wallets receive the smaller amounts.
    const remittances = 5 + random.integer(0, 3);
    for (let count = 0; count < remittances; count += 1) {
      const corridor = random.pick(["AE-BD", "AE-BD", "SA-BD", "SA-BD", "SA-BD", "MY-BD", "US-BD", "US-BD"]);
      const beneficiary = random.pick(people);
      const ceiling = beneficiary.tier === "Basic" ? 0.35 : 1;
      const range: Record<string, [number, number]> = {
        "AE-BD": [500, 3_200],
        "SA-BD": [400, 2_800],
        "MY-BD": [300, 1_900],
        "US-BD": [100, 1_400],
      };
      const [min, max] = range[corridor] as [number, number];
      const sourceAmount = Math.round(random.between(min, Math.max(min + 50, max * ceiling)) / 10) * 10;
      remit(during(day), day, corridor, beneficiary, sourceAmount);
    }

    // End of day: the auditor reconciles the ledger against the chain.
    add(day.closes - 2 * 60, "reconciliation", () => as("auditor", "POST", "/v1/reconciliation"));
  }

  // Remittances above the screening threshold and the compliance decisions on them.
  const dayAt = (index: number) => days[Math.min(index, days.length - 1)] as BusinessDay;
  const tanvir = byLabel("Tanvir Ahmed");
  const karim = byLabel("Abdul Karim");
  const mizanur = byLabel("Mizanur Rahman");
  const sultana = byLabel("Sultana Parvin");
  if (days.length >= 5) {
    remit(dayAt(1).opens + 2 * HOUR, dayAt(1), "US-BD", tanvir, 6_500, true);
    decide(dayAt(1).opens + 5 * HOUR, tanvir, "release");
    remit(dayAt(3).opens + 6 * HOUR, dayAt(3), "AE-BD", karim, 21_000, true);
    decide(dayAt(4).opens + 40 * 60, karim, "release");
    remit(dayAt(4).opens + 2 * HOUR, dayAt(4), "SA-BD", mizanur, 18_000, true);
    decide(dayAt(4).opens + 6 * HOUR, mizanur, "reject", "DOCS-NOT-PROVIDED");
  }
  remit(lastDay.closes - 80 * 60, lastDay, "US-BD", sultana, 8_000, true);

  // A refund, an issuance request that the checker turns down, and a settled redemption.
  const midWeek = dayAt(2);
  add(midWeek.closes - 3 * HOUR, "refund", async () => {
    const payments = await as<{ id: string; amount: string; payer: string; merchantId: string }[]>(
      "admin.surma",
      "GET",
      "/v1/payments?kind=merchant&merchant=BHORER-01&limit=5",
    );
    const payment = payments[0];
    if (!payment) return;
    const amount = BigInt(payment.amount) / 2n;
    await as("admin.surma", "POST", `/v1/payments/${payment.id}/refund`, { amount: decimal(amount) });
    credit(payment.payer, amount);
  });
  add(midWeek.opens + 3 * HOUR, "issuance requested with a wrong amount", () =>
    as("maker.teesta", "POST", "/v1/reserves/issuance", {
      institution: "HALDA",
      amount: decimal(lakh(75)),
      fundingRef: nextRef("RTGS-HALDA", midWeek),
    }),
  );
  add(midWeek.opens + 4 * HOUR, "issuance rejected", async () => {
    const reserves = await as<{ issuance: { id: string; status: string }[] }>("checker.teesta", "GET", "/v1/reserves");
    const pending = reserves.issuance.find((item) => item.status === "Pending");
    if (pending) {
      await as("checker.teesta", "POST", `/v1/reserves/issuance/${pending.id}/reject`, { reason: "AMOUNT-MISMATCH" });
    }
  });
  const redemptionDay = dayAt(3);
  add(redemptionDay.opens + 4 * HOUR, "redemption requested by SURMA", () =>
    as("admin.surma", "POST", "/v1/reserves/redemptions", {
      amount: decimal(lakh(25)),
      payoutRef: nextRef("BEFTN-SURMA", redemptionDay),
    }),
  );
  add(redemptionDay.opens + 7 * HOUR, "redemption settled", async () => {
    const reserves = await as<{ redemptions: { id: string; status: string }[] }>(
      "checker.teesta",
      "GET",
      "/v1/reserves",
    );
    const pending = reserves.redemptions.find((item) => item.status === "Pending");
    if (pending) await as("checker.teesta", "POST", `/v1/reserves/redemptions/${pending.id}/settle`);
  });

  // Payroll of the garment factory. One worker's wallet is frozen, so that payout fails and returns.
  const payrollDay = dayAt(5);
  const frozenWorker = workers.find((worker) => worker.label === "Kulsum Begum") ?? (workers[0] as Account);
  add(dayAt(4).opens + 5 * HOUR, `freeze ${frozenWorker.label}`, () =>
    as(ADMIN[frozenWorker.institutionId] as string, "POST", `/v1/accounts/${frozenWorker.address}/freeze`, {
      reason: "SIM-SWAP-2026-1107",
    }),
  );
  const wages = workers.map((worker) => ({ account: worker.address, amount: amountBetween(12_500, 16_800, 50) }));
  const payrollRef = `PAYROLL-${payrollDay.date.slice(0, 7)}`;
  add(payrollDay.opens + 60 * 60, "payroll batch funded", () =>
    as("admin.surma", "POST", "/v1/disbursements", {
      payer: factory.address,
      batchRef: payrollRef,
      purpose: "SALA",
      payouts: wages.map((wage) => ({ account: wage.account, amount: decimal(wage.amount) })),
    }),
  );
  const payrollBatch = async () => {
    const batches = await as<{ id: string; batchRef: string }[]>("admin.surma", "GET", "/v1/disbursements");
    const batch = batches.find((item) => item.batchRef === payrollRef);
    if (!batch) throw new Error("The payroll batch was not created");
    return batch.id;
  };
  add(payrollDay.opens + 150 * 60, "payroll batch approved", async () =>
    as("admin.surma", "POST", `/v1/disbursements/${await payrollBatch()}/approve`),
  );
  add(payrollDay.opens + 5 * HOUR, "payroll executed", async () => {
    await as("admin.surma", "POST", `/v1/disbursements/${await payrollBatch()}/execute`);
    for (const wage of wages) if (wage.account !== frozenWorker.address) credit(wage.account, wage.amount);
  });
  add(payrollDay.opens + 7 * HOUR, "payroll batch closed", async () =>
    as("admin.surma", "POST", `/v1/disbursements/${await payrollBatch()}/close`),
  );

  // Work left open for the people who decide: an allowance batch, an issuance and a redemption.
  const beneficiaries = [...people.filter((person) => person.tier === "Basic"), ...workers.slice(0, 6)];
  add(lastDay.closes - 70 * 60, "allowance batch funded", () =>
    as("admin.halda", "POST", "/v1/disbursements", {
      payer: allowanceOffice.address,
      batchRef: `ALLOWANCE-${lastDay.date.slice(0, 7)}`,
      purpose: "SSBE",
      payouts: beneficiaries.map((person) => ({ account: person.address, amount: "1950.00" })),
    }),
  );
  add(lastDay.closes - 55 * 60, "issuance requested for HALDA", () =>
    as("maker.teesta", "POST", "/v1/reserves/issuance", {
      institution: "HALDA",
      amount: decimal(crore(1)),
      fundingRef: nextRef("RTGS-HALDA", lastDay),
    }),
  );
  add(lastDay.closes - 45 * 60, "redemption requested by SANGU", () =>
    as("admin.sangu", "POST", "/v1/reserves/redemptions", {
      amount: decimal(lakh(15)),
      payoutRef: nextRef("BEFTN-SANGU", lastDay),
    }),
  );

  return steps.sort((first, second) => first.at - second.at);
}

// ------------------------------------------------------------------ run

async function main(): Promise<void> {
  const overview = await as<{ headline: { supply: string } }>("ops.network", "GET", "/v1/overview");
  if (overview.headline.supply !== "0") {
    console.log("This chain already carries activity; the scenario plays once on a fresh deployment.");
    return;
  }

  const directory = await loadDirectory();
  const days = await planCalendar();
  const steps = buildWeek(days, directory);
  const clock = new Clock();
  console.log(
    `Playing ${steps.length} steps over ${days.length} business days (${days[0]?.date} to ${days.at(-1)?.date})`,
  );

  let currentDay = "";
  for (const step of steps) {
    const date = new Date((step.at + DHAKA_UTC_OFFSET) * 1000).toISOString().slice(0, 10);
    if (date !== currentDay) {
      currentDay = date;
      console.log(`\n${date}`);
    }
    await clock.moveTo(step.at);
    try {
      const outcome = await step.run();
      if (outcome === SKIPPED) stats.skipped += 1;
      else stats.played += 1;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 422) throw error;
      // The network refused the step, for instance a limit was reached. The week goes on.
      stats.skipped += 1;
      console.log(`  refused: ${step.label} (${error.message})`);
    }
  }
  await clock.returnToPresent();

  const summary = await as<{ headline: { supply: string }; reconciliation: { status: string } | null }>(
    "ops.network",
    "GET",
    "/v1/overview",
  );
  console.log(
    `\nDone: ${stats.played} steps played, ${stats.skipped} skipped. ` +
      `Supply ${decimal(BigInt(summary.headline.supply))} tBDT, reconciliation ${summary.reconciliation?.status ?? "not run"}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
