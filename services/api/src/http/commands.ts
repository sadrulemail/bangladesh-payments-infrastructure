import type { Abi, Account, ContractFunctionName, Hex } from "viem";

import type { Operator } from "../chain/custody";
import { type ContractCall, send } from "../chain/transactions";
import { pool } from "../db/pool";
import { indexer } from "../indexer/indexer";
import { ContractRevert } from "../lib/errors";

export interface CommandResult {
  txHash: Hex;
  blockNumber: string;
}

const toJson = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));

async function audit(
  operator: Operator,
  action: string,
  signer: string,
  details: Record<string, unknown>,
  outcome: "Accepted" | "Rejected",
  txHash: string | null,
  error: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (operator, action, signer, details, outcome, tx_hash, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [operator.username, action, signer.toLowerCase(), toJson(details), outcome, txHash, error],
  );
}

/**
 * Submits a command on behalf of an operator and records it in the audit log whether the network
 * accepts it or not. Returns once the read models include the transaction, so a query that follows
 * sees its effect.
 */
export async function execute<
  const TAbi extends Abi,
  TName extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
>(
  operator: Operator,
  action: string,
  details: Record<string, unknown>,
  signer: Account,
  call: ContractCall<TAbi, TName>,
): Promise<CommandResult> {
  try {
    const receipt = await send(signer, call);
    await indexer.caughtUpTo(receipt.blockNumber);
    await audit(operator, action, signer.address, details, "Accepted", receipt.txHash, null);
    return { txHash: receipt.txHash, blockNumber: receipt.blockNumber.toString() };
  } catch (error) {
    const reason = error instanceof ContractRevert ? error.reason : error instanceof Error ? error.message : "Unknown";
    await audit(operator, action, signer.address, details, "Rejected", null, reason);
    throw error;
  }
}
