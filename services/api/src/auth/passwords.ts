import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const COST = 2 ** 15;
const OPTIONS = { N: COST, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Hashes a passphrase with scrypt. The result carries its own salt and cost. */
export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, KEY_LENGTH, OPTIONS);
  return `scrypt$${COST}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Checks a passphrase against a stored hash in constant time. */
export function verifyPassphrase(passphrase: string, stored: string): boolean {
  const [scheme, cost, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !cost || !salt || !key) return false;

  const expected = Buffer.from(key, "base64");
  const actual = scryptSync(passphrase, Buffer.from(salt, "base64"), expected.length, { ...OPTIONS, N: Number(cost) });
  return timingSafeEqual(actual, expected);
}
