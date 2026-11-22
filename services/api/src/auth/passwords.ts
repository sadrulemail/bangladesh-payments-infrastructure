import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const COST = 2 ** 15;
const OPTIONS = { r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Costs a stored hash may carry: powers of two from 2^14 to 2^16, which fit in `maxmem`. */
const isAcceptedCost = (cost: number) => Number.isInteger(Math.log2(cost)) && cost >= 2 ** 14 && cost <= 2 ** 16;

/** Derives a scrypt key on the thread pool, so a sign-in never holds up other requests. */
function derive(passphrase: string, salt: Buffer, cost: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, length, { ...OPTIONS, N: cost }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Hashes a passphrase with scrypt. The result carries its own salt and cost. */
export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(passphrase, salt, COST, KEY_LENGTH);
  return `scrypt$${COST}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Checks a passphrase against a stored hash in constant time. A malformed hash never matches. */
export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const [scheme, costText, salt, key] = stored.split("$");
  const cost = Number(costText);
  if (scheme !== "scrypt" || !isAcceptedCost(cost) || !salt || !key) return false;

  const expected = Buffer.from(key, "base64");
  if (expected.length === 0) return false;
  const actual = await derive(passphrase, Buffer.from(salt, "base64"), cost, expected.length);
  return timingSafeEqual(actual, expected);
}
