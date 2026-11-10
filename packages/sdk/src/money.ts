/**
 * Money maths. Amounts are integers in the minor unit of their currency (poisha for taka), and
 * exchange rates are integers scaled by one million. Nothing here touches floating point.
 */

export const TAKA_DECIMALS = 2;
export const RATE_DECIMALS = 6;
export const RATE_SCALE = 1_000_000n;
export const BPS = 10_000n;

const DECIMAL = /^\d+(\.\d+)?$/;
const TAKA_SIGN = "৳";
const LAKH = 100_000n * 100n;
const CRORE = 10_000_000n * 100n;

/** Parses a decimal string such as "1,250.50" into an integer with `decimals` fractional digits. */
export function parseDecimal(value: string | number, decimals: number): bigint {
  const text = String(value).replace(/,/g, "").trim();
  if (!DECIMAL.exec(text)) throw new RangeError(`"${value}" is not a decimal amount`);

  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new RangeError(`"${value}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Renders an integer with `decimals` fractional digits as a plain decimal string. */
export function formatDecimal(value: bigint | string, decimals: number): string {
  const amount = BigInt(value);
  const digits = (amount < 0n ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const sign = amount < 0n ? "-" : "";
  return decimals === 0 ? `${sign}${whole}` : `${sign}${whole}.${digits.slice(-decimals)}`;
}

/** Taka amount to poisha. */
export const parseTaka = (value: string | number) => parseDecimal(value, TAKA_DECIMALS);

/** Exchange rate, in taka per unit of foreign currency, to its scaled integer. */
export const parseRate = (value: string | number) => parseDecimal(value, RATE_DECIMALS);

/** Groups digits the Bangladeshi way: 1234567 becomes 12,34,567. */
export function groupLakh(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${digits.slice(-3)}`;
}

/** Poisha to a display amount such as "৳12,34,567.89". */
export function formatTaka(poisha: bigint | string, options: { symbol?: boolean } = {}): string {
  const plain = formatDecimal(poisha, TAKA_DECIMALS);
  const negative = plain.startsWith("-");
  const [whole = "0", fraction = "00"] = plain.replace("-", "").split(".");
  const symbol = options.symbol === false ? "" : TAKA_SIGN;
  return `${negative ? "-" : ""}${symbol}${groupLakh(whole)}.${fraction}`;
}

/** Poisha to a short amount in lakh or crore, such as "৳3.42 crore". */
export function compactTaka(poisha: bigint | string): string {
  const amount = BigInt(poisha);
  const magnitude = amount < 0n ? -amount : amount;
  if (magnitude < LAKH) return formatTaka(amount);

  const [unit, label] = magnitude >= CRORE ? [CRORE, "crore"] : [LAKH, "lakh"];
  const scaled = (magnitude * 100n + unit / 2n) / unit;
  return `${amount < 0n ? "-" : ""}${TAKA_SIGN}${formatDecimal(scaled, 2)} ${label}`;
}

/** Scaled rate to a display string with `digits` decimal places. */
export function formatRate(rate: bigint | string, digits = 4): string {
  const plain = formatDecimal(rate, RATE_DECIMALS);
  return plain.slice(0, plain.length - (RATE_DECIMALS - digits));
}

/** Converts minor units of a foreign currency to poisha at `rate`, rounding down as the gateway does. */
export function convertToTaka(sourceAmount: bigint, rate: bigint): bigint {
  return (sourceAmount * rate) / RATE_SCALE;
}

/** Share of `amount` expressed in basis points, rounded down. */
export function basisPoints(amount: bigint, bps: bigint | number): bigint {
  return (amount * BigInt(bps)) / BPS;
}
