/**
 * Posts token movements to the double-entry ledger.
 *
 *   issuance    Dr reserve trust account   Cr wallet of the receiver
 *   transfer    Dr wallet of the sender    Cr wallet of the receiver
 *   redemption  Dr wallet of the sender    Cr reserve trust account
 *
 * The database checks that every entry balances when its transaction commits.
 */
import { type Queryable, queryOne } from "../db/pool";

export const RESERVE_ACCOUNT_CODE = "1000";
export const WALLET_ACCOUNT_PREFIX = "2000";

export interface TransferPosting {
  /** Sender wallet, or null when the tokens are minted. */
  from: string | null;
  /** Receiver wallet, or null when the tokens are burned. */
  to: string | null;
  amount: bigint;
  blockNumber: bigint;
  postedAt: string;
  txHash: string;
  logIndex: number;
}

export type EntryType = "issuance" | "redemption" | "transfer";

export const entryTypeOf = (posting: Pick<TransferPosting, "from" | "to">): EntryType =>
  posting.from === null ? "issuance" : posting.to === null ? "redemption" : "transfer";

async function reserveAccountId(db: Queryable): Promise<number> {
  const account = await queryOne<{ id: number }>(db, "SELECT id FROM ledger_accounts WHERE code = $1", [
    RESERVE_ACCOUNT_CODE,
  ]);
  if (!account) throw new Error("The reserve ledger account is missing");
  return account.id;
}

/** Ledger account of a wallet, opened on its first movement. */
async function walletAccountId(db: Queryable, wallet: string): Promise<number> {
  const account = await queryOne<{ id: number }>(
    db,
    `INSERT INTO ledger_accounts (code, name, category, wallet)
     VALUES ($1, $2, 'liability', $3)
     ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet
     RETURNING id`,
    [`${WALLET_ACCOUNT_PREFIX}:${wallet}`, `Wallet ${wallet}`, wallet],
  );
  if (!account) throw new Error(`Could not open a ledger account for ${wallet}`);
  return account.id;
}

export async function postTransfer(db: Queryable, posting: TransferPosting): Promise<void> {
  const debitAccount = posting.from === null ? await reserveAccountId(db) : await walletAccountId(db, posting.from);
  const creditAccount = posting.to === null ? await reserveAccountId(db) : await walletAccountId(db, posting.to);

  const entry = await queryOne<{ id: string }>(
    db,
    `INSERT INTO journal_entries (entry_type, block_number, posted_at, tx_hash, log_index)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [entryTypeOf(posting), posting.blockNumber, posting.postedAt, posting.txHash, posting.logIndex],
  );
  if (!entry) throw new Error("Could not create the journal entry");

  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
     VALUES ($1, $2, $4, 0), ($1, $3, 0, $4)`,
    [entry.id, debitAccount, creditAccount, posting.amount],
  );
}
