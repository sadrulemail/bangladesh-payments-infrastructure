import { PURPOSE_CODES, type PurposeCode } from "@takarail/sdk/domain";
import { compactTaka, formatDecimal, formatRate, formatTaka, groupLakh } from "@takarail/sdk/money";

export { compactTaka, formatRate, formatTaka };

const DHAKA = "Asia/Dhaka";

const dateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: DHAKA,
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateOnly = new Intl.DateTimeFormat("en-GB", { timeZone: DHAKA, day: "2-digit", month: "short", year: "numeric" });
const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric" });

/** Timestamp as Dhaka date and time, for instance "09 Nov, 14:05". */
export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : "-");

export const formatDate = (iso: string | null | undefined) => (iso ? dateOnly.format(new Date(iso)) : "-");

/** Business date ("2026-11-09") as a short axis label, for instance "Mon 9". */
export const formatBusinessDay = (date: string) => weekday.format(new Date(`${date}T00:00:00Z`));

/** Amount in a foreign currency from its minor units, for instance "AED 1,250.00". */
export function formatForeign(minorUnits: string | bigint, currency: string): string {
  const [whole = "0", fraction = "00"] = formatDecimal(minorUnits, 2).split(".");
  return `${currency} ${Number(whole).toLocaleString("en-US")}.${fraction}`;
}

/** Whole count with lakh grouping. */
export const formatCount = (value: number | string) => groupLakh(String(value));

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

/** Basis points as a percentage, for instance 250 as "2.5%". */
export const formatBps = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2).replace(/0$/, "")}%`;

export const purposeLabel = (code: string | null) =>
  code && code in PURPOSE_CODES ? PURPOSE_CODES[code as PurposeCode] : (code ?? "-");

/** "MobileFinancialService" as "Mobile financial service". */
export function humanise(value: string): string {
  const words = value
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Share of `part` in `whole` as a percentage with one decimal. */
export function percentage(part: string | bigint, whole: string | bigint): string {
  const denominator = BigInt(whole);
  if (denominator === 0n) return "-";
  const tenths = (BigInt(part) * 1000n) / denominator;
  return `${formatDecimal(tenths, 1)}%`;
}

/** Poisha as a plain number of taka, for chart scales only. */
export const toTakaNumber = (poisha: string | bigint) => Number(BigInt(poisha)) / 100;
