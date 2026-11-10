/**
 * Custody keystore. Institutions hold keys on behalf of their customers, as banks and mobile money
 * providers do today, so every wallet the API signs for is derived from one mnemonic by index.
 * Only the index is stored. In production the same interface sits in front of an HSM or a KMS.
 */
import type { Address } from "viem";
import { type HDAccount, mnemonicToAccount } from "viem/accounts";

import { config } from "../config";
import { type Queryable, pool, queryOne } from "../db/pool";
import { forbidden, notFound } from "../lib/errors";

export interface Operator {
  username: string;
  displayName: string;
  role: OperatorRole;
  institutionId: string | null;
  address: Address;
  keyIndex: number;
}

export const OPERATOR_ROLES = [
  "network_operator",
  "supervisor",
  "issuance_maker",
  "reserve_checker",
  "reserve_auditor",
  "compliance_officer",
  "institution_admin",
  "exchange_house",
  "treasury",
] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

const cache = new Map<number, HDAccount>();

/** Signing account at derivation index `index` (path m/44'/60'/0'/0/index). */
export function accountAt(index: number): HDAccount {
  let account = cache.get(index);
  if (!account) {
    account = mnemonicToAccount(config.custody.mnemonic, { addressIndex: index });
    cache.set(index, account);
  }
  return account;
}

/** The operator's own key: the one that holds their role on chain. */
export const signerOfOperator = (operator: Operator) => accountAt(operator.keyIndex);

/**
 * Key of a wallet in custody. An operator may only sign for wallets of their own institution.
 */
export async function signerOfWallet(operator: Operator, wallet: string): Promise<HDAccount> {
  const key = await queryOne<{ keyIndex: number; institutionId: string }>(
    pool,
    "SELECT key_index, institution_id FROM custody_keys WHERE address = $1",
    [wallet.toLowerCase()],
  );
  if (!key) throw notFound(`Wallet ${wallet} in custody`);
  if (key.institutionId !== operator.institutionId) {
    throw forbidden("This wallet is held by another institution");
  }
  return accountAt(key.keyIndex);
}

/** Settlement account of the operator's institution. */
export async function settlementSignerOf(operator: Operator): Promise<HDAccount> {
  if (!operator.institutionId) throw forbidden("Your profile is not attached to an institution");
  const institution = await queryOne<{ settlementAccount: string }>(
    pool,
    "SELECT settlement_account FROM institutions WHERE id = $1",
    [operator.institutionId],
  );
  if (!institution) throw notFound(`Institution ${operator.institutionId}`);
  return signerOfWallet(operator, institution.settlementAccount);
}

/**
 * Reserves the next free key for a new wallet of `institutionId`.
 * Call it inside a transaction: the table lock keeps two allocations from taking the same index.
 */
export async function allocateWallet(db: Queryable, institutionId: string): Promise<HDAccount> {
  await db.query("LOCK TABLE custody_keys IN EXCLUSIVE MODE");
  const next = await queryOne<{ keyIndex: number }>(
    db,
    `SELECT COALESCE(MAX(key_index), -1) + 1 AS key_index
       FROM (SELECT key_index FROM custody_keys UNION ALL SELECT key_index FROM operators) AS keys`,
  );
  if (!next) throw new Error("Could not allocate a custody key");

  const account = accountAt(next.keyIndex);
  await db.query("INSERT INTO custody_keys (address, key_index, institution_id) VALUES ($1, $2, $3)", [
    account.address.toLowerCase(),
    next.keyIndex,
    institutionId,
  ]);
  return account;
}
