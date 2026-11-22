import type { Abi, Account, ContractFunctionName, Hex } from "viem";

import type { Operator } from "../chain/custody";
import { type ContractCall, type Receipt, send } from "../chain/transactions";
import { pool } from "../db/pool";
import { indexer } from "../indexer/indexer";
import { ContractRevert } from "../lib/errors";
import { toJson } from "../lib/json";

export interface CommandResult {
  txHash: Hex;
  blockNumber: string;
  /** False when the read models had not reached the block in time. They catch up on their own. */
  indexed: boolean;
}

interface AuditEntry {
  operator: Operator;
  action: string;
  signer: string;
  details: Record<string, unknown>;
}

async function audit(
  entry: AuditEntry,
  outcome: "Accepted" | "Rejected",
  txHash: string | null,
  error: string | null,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (operator, action, signer, details, outcome, tx_hash, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.operator.username,
        entry.action,
        entry.signer.toLowerCase(),
        toJson(entry.details),
        outcome,
        txHash,
        error,
      ],
    );
  } catch (failure) {
    // The network has already decided the command; a lost audit line must not change the answer.
    console.error(
      `Could not record ${entry.action} (${outcome}, ${txHash ?? "no transaction"}) in the audit log`,
      failure,
    );
  }
}

const reasonOf = (error: unknown) =>
  error instanceof ContractRevert ? error.reason : error instanceof Error ? error.message : "Unknown";

/**
 * Submits a command on behalf of an operator and records it in the audit log whether the network
 * accepts it or not. Once accepted, it waits for the read models to include the transaction, so a query
 * that follows sees its effect.
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
  const entry: AuditEntry = { operator, action, signer: signer.address, details };
  let receipt: Receipt;
  try {
    receipt = await send(signer, call);
  } catch (error) {
    await audit(entry, "Rejected", null, reasonOf(error));
    throw error;
  }

  // The transaction is settled from here on, whatever happens to the read models: answering with an
  // error now would invite the operator to send it a second time.
  const { txHash, blockNumber } = receipt;
  await audit(entry, "Accepted", txHash, null);
  const indexed = await indexer.caughtUpTo(blockNumber).then(
    () => true,
    (error: unknown) => {
      console.warn(`${action} settled in block ${blockNumber}; the read models have not reached it yet`, error);
      return false;
    },
  );
  return { txHash, blockNumber: blockNumber.toString(), indexed };
}
