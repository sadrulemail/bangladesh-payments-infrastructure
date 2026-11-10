/** Input schemas shared by the routes. */
import { PURPOSE_CODES, type PurposeCode, parseRate, parseTaka } from "@takarail/sdk";
import type { Address } from "viem";
import { z } from "zod";

const decimal = (parse: (value: string) => bigint, what: string) =>
  z
    .union([z.string(), z.number()])
    .transform((value, context) => {
      try {
        const parsed = parse(String(value));
        if (parsed > 0n) return parsed;
      } catch {
        // Reported below.
      }
      context.addIssue({ code: "custom", message: `Expected ${what}` });
      return z.NEVER;
    })
    .describe(what);

/** Wallet address, normalised to lower case. */
export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Expected a wallet address")
  .transform((value) => value.toLowerCase() as Address);

/** Positive taka amount such as "1250.50", parsed to poisha. */
export const takaAmount = decimal(parseTaka, "a positive taka amount with at most two decimal places");

/** Positive amount in a foreign currency, parsed to its minor unit. */
export const sourceAmount = decimal(parseTaka, "a positive amount with at most two decimal places");

/** Exchange rate in taka per unit of foreign currency, parsed to its scaled integer. */
export const exchangeRate = decimal(parseRate, "a positive exchange rate with at most six decimal places");

/** Short printable reference that fits a bytes32 on chain. */
export const reference = z
  .string()
  .trim()
  .min(1)
  .max(31)
  .regex(/^[\x20-\x7e]+$/, "Use printable ASCII characters only");

/** Short code such as an institution, merchant or corridor id. */
export const shortCode = z
  .string()
  .trim()
  .min(2)
  .max(31)
  .regex(/^[A-Z0-9-]+$/, "Use capital letters, digits and hyphens");

export const purposeCode = z.enum(Object.keys(PURPOSE_CODES) as [PurposeCode, ...PurposeCode[]]);

/** Numeric id carried in the path. */
export const idParams = z.object({ id: z.coerce.bigint().min(0n) });

export const addressParams = z.object({ address });

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date as YYYY-MM-DD");
