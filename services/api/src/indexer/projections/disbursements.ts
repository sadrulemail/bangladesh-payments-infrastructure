import { fromAscii, fromCode } from "@takarail/sdk";
import type { Address, Hex } from "viem";

import { queryOne } from "../../db/pool";
import { type Projection, type ProjectionMap, lower } from "../types";

interface StoredPayout {
  index: number;
  account: string;
  amount: string;
}

/** Opens the batch and, when this service holds its payout list, lays out the payouts as pending. */
const batchCreated: Projection<{
  batchId: bigint;
  payer: Address;
  payerInstitution: Hex;
  batchRef: Hex;
  merkleRoot: Hex;
  total: bigint;
  count: number;
  purpose: Hex;
}> = async (db, { args, blockTime, txHash }) => {
  const payer = lower(args.payer);
  const batchRef = fromCode(args.batchRef);
  await db.query(
    `INSERT INTO disbursement_batches
       (id, payer, payer_institution_id, batch_ref, merkle_root, total, payout_count, purpose, status,
        created_at, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AwaitingApproval', $9, $10)`,
    [
      args.batchId,
      payer,
      fromCode(args.payerInstitution),
      batchRef,
      args.merkleRoot,
      args.total,
      args.count,
      fromAscii(args.purpose),
      blockTime,
      txHash,
    ],
  );

  const list = await queryOne<{ entries: StoredPayout[] }>(
    db,
    "SELECT entries FROM disbursement_payout_lists WHERE payer = $1 AND batch_ref = $2",
    [payer, batchRef],
  );
  for (const entry of list?.entries ?? []) {
    await db.query("INSERT INTO disbursement_payouts (batch_id, idx, account, amount) VALUES ($1, $2, $3, $4)", [
      args.batchId,
      entry.index,
      lower(entry.account),
      entry.amount,
    ]);
  }
};

const batchApproved: Projection<{ batchId: bigint }> = async (db, { args, blockTime }) => {
  await db.query("UPDATE disbursement_batches SET status = 'Approved', approved_at = $2 WHERE id = $1", [
    args.batchId,
    blockTime,
  ]);
};

const batchRejected: Projection<{ batchId: bigint; reason: Hex }> = async (db, { args, blockTime }) => {
  await db.query(
    `UPDATE disbursement_batches
        SET status = 'Rejected', reason = $2, closed_at = $3, returned = total
      WHERE id = $1`,
    [args.batchId, fromCode(args.reason), blockTime],
  );
};

/** Marks one payout as settled or failed and moves the batch counters with it. */
const payoutProcessed =
  (status: "Settled" | "Failed"): Projection<{ batchId: bigint; index: number; account: Address; amount: bigint }> =>
  async (db, { args, blockTime, txHash }) => {
    await db.query(
      `INSERT INTO disbursement_payouts (batch_id, idx, account, amount, status, processed_at, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (batch_id, idx) DO UPDATE
         SET status = EXCLUDED.status, processed_at = EXCLUDED.processed_at, tx_hash = EXCLUDED.tx_hash`,
      [args.batchId, args.index, lower(args.account), args.amount, status, blockTime, txHash],
    );
    const column = status === "Settled" ? "paid" : "failed";
    await db.query(
      `UPDATE disbursement_batches SET ${column} = ${column} + $2, processed = processed + 1 WHERE id = $1`,
      [args.batchId, args.amount],
    );
  };

const batchClosed: Projection<{ batchId: bigint; returned: bigint }> = async (db, { args, blockTime }) => {
  await db.query("UPDATE disbursement_batches SET status = 'Closed', returned = $2, closed_at = $3 WHERE id = $1", [
    args.batchId,
    args.returned,
    blockTime,
  ]);
};

export const disbursementProjections = {
  BatchCreated: batchCreated,
  BatchApproved: batchApproved,
  BatchRejected: batchRejected,
  PayoutSettled: payoutProcessed("Settled"),
  PayoutFailed: payoutProcessed("Failed"),
  BatchClosed: batchClosed,
} as ProjectionMap;
