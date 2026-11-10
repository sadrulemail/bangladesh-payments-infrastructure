/**
 * Three-way reconciliation at one block:
 *
 *   1. every wallet balance in the ledger equals `balanceOf` on chain,
 *   2. wallet liabilities, the reserve asset and `totalSupply` are the same figure,
 *   3. that figure is covered by the most recent reserve statement.
 */
import type { Address } from "viem";

import { contracts, publicClient } from "../chain/network";
import { pool, query, queryOne } from "../db/pool";
import { RESERVE_ACCOUNT_CODE } from "./posting";

const READS_IN_PARALLEL = 25;

export interface Mismatch {
  wallet: string;
  ledger: string;
  chain: string;
}

export interface ReconciliationRun {
  id: string;
  runAt: string;
  blockNumber: string;
  totalSupply: string;
  ledgerLiabilities: string;
  ledgerReserve: string;
  reportedReserve: string | null;
  walletsChecked: number;
  mismatches: Mismatch[];
  status: "Balanced" | "Mismatch";
  triggeredBy: string;
}

interface LedgerSnapshot {
  blockNumber: bigint;
  wallets: { wallet: string; balance: bigint }[];
  reserve: bigint;
  reportedReserve: string | null;
}

/** Reads the cursor and the ledger from one snapshot, so both describe the same block. */
async function ledgerSnapshot(): Promise<LedgerSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const cursor = await queryOne<{ blockNumber: string }>(
      client,
      "SELECT block_number FROM indexer_cursor WHERE id = 1",
    );
    const balances = await query<{ code: string; wallet: string | null; balance: string }>(
      client,
      "SELECT code, wallet, balance FROM ledger_balances",
    );
    const statement = await queryOne<{ balance: string }>(
      client,
      "SELECT balance FROM reserve_statements ORDER BY idx DESC LIMIT 1",
    );
    await client.query("COMMIT");

    if (!cursor) throw new Error("The indexer has not processed any block yet");
    return {
      blockNumber: BigInt(cursor.blockNumber),
      wallets: balances
        .filter((row): row is typeof row & { wallet: string } => row.wallet !== null)
        .map((row) => ({ wallet: row.wallet, balance: BigInt(row.balance) })),
      reserve: BigInt(balances.find((row) => row.code === RESERVE_ACCOUNT_CODE)?.balance ?? 0),
      reportedReserve: statement?.balance ?? null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function chainBalances(wallets: string[], blockNumber: bigint): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();
  for (let start = 0; start < wallets.length; start += READS_IN_PARALLEL) {
    const chunk = wallets.slice(start, start + READS_IN_PARALLEL);
    const values = await Promise.all(
      chunk.map((wallet) =>
        publicClient.readContract({
          ...contracts.token,
          functionName: "balanceOf",
          args: [wallet as Address],
          blockNumber,
        }),
      ),
    );
    chunk.forEach((wallet, index) => balances.set(wallet, values[index] as bigint));
  }
  return balances;
}

export async function reconcile(triggeredBy: string): Promise<ReconciliationRun> {
  const snapshot = await ledgerSnapshot();
  const { blockNumber } = snapshot;

  const totalSupply = await publicClient.readContract({ ...contracts.token, functionName: "totalSupply", blockNumber });
  const onChain = await chainBalances(
    snapshot.wallets.map((row) => row.wallet),
    blockNumber,
  );

  const mismatches: Mismatch[] = snapshot.wallets
    .filter((row) => onChain.get(row.wallet) !== row.balance)
    .map((row) => ({
      wallet: row.wallet,
      ledger: row.balance.toString(),
      chain: (onChain.get(row.wallet) ?? 0n).toString(),
    }));
  const liabilities = snapshot.wallets.reduce((sum, row) => sum + row.balance, 0n);
  const balanced = mismatches.length === 0 && liabilities === totalSupply && snapshot.reserve === totalSupply;

  const run = await queryOne<ReconciliationRun>(
    pool,
    `INSERT INTO reconciliation_runs
       (block_number, total_supply, ledger_liabilities, ledger_reserve, reported_reserve, wallets_checked,
        mismatches, status, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      blockNumber,
      totalSupply,
      liabilities,
      snapshot.reserve,
      snapshot.reportedReserve,
      snapshot.wallets.length,
      JSON.stringify(mismatches),
      balanced ? "Balanced" : "Mismatch",
      triggeredBy,
    ],
  );
  if (!run) throw new Error("Could not record the reconciliation run");
  return run;
}
