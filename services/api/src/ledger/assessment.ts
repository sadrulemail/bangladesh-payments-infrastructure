/**
 * Outcome of a reconciliation run, from figures read at one block.
 *
 *   Mismatch   the ledger disagrees with the chain: a wallet balance, the total of wallet liabilities or
 *              the reserve asset account differs from what the chain holds
 *   Shortfall  the books agree with the chain, but the supply is larger than the most recent reserve
 *              statement, or tokens are in issue and no statement has been published
 *   Balanced   neither
 *
 * A mismatch is reported first: until the books agree, the comparison with the reserve means little.
 */
export type ReconciliationStatus = "Balanced" | "Mismatch" | "Shortfall";

export interface Mismatch {
  wallet: string;
  ledger: string;
  chain: string;
}

export interface ReconciliationFigures {
  /** Ledger balance of every wallet account. */
  ledger: readonly { wallet: string; balance: bigint }[];
  /** `balanceOf` of the same wallets on chain. */
  chain: ReadonlyMap<string, bigint>;
  totalSupply: bigint;
  /** Balance of the reserve asset account in the ledger. */
  ledgerReserve: bigint;
  /** Balance of the most recent reserve statement, or null when none has been published. */
  reportedReserve: bigint | null;
}

export interface Assessment {
  status: ReconciliationStatus;
  mismatches: Mismatch[];
  /** Total of the wallet balances in the ledger. */
  liabilities: bigint;
}

export function assess(figures: ReconciliationFigures): Assessment {
  const { ledger, chain, totalSupply, ledgerReserve, reportedReserve } = figures;

  const mismatches = ledger
    .filter((row) => chain.get(row.wallet) !== row.balance)
    .map((row) => ({
      wallet: row.wallet,
      ledger: row.balance.toString(),
      chain: (chain.get(row.wallet) ?? 0n).toString(),
    }));
  const liabilities = ledger.reduce((sum, row) => sum + row.balance, 0n);

  const booksAgree = mismatches.length === 0 && liabilities === totalSupply && ledgerReserve === totalSupply;
  const covered = totalSupply === 0n || (reportedReserve !== null && reportedReserve >= totalSupply);
  const status: ReconciliationStatus = !booksAgree ? "Mismatch" : covered ? "Balanced" : "Shortfall";
  return { status, mismatches, liabilities };
}
