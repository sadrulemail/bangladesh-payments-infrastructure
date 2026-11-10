import { fromCode } from "@takarail/sdk";
import type { Address, Hex } from "viem";

import { type Projection, type ProjectionMap, lower } from "../types";

const toIso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

const statementPublished: Projection<{
  index: bigint;
  asOf: bigint;
  balance: bigint;
  documentHash: Hex;
  publisher: Address;
}> = async (db, { args, blockTime, txHash }) => {
  await db.query(
    `INSERT INTO reserve_statements (idx, as_of, balance, document_hash, publisher, published_at, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [args.index, toIso(args.asOf), args.balance, args.documentHash, lower(args.publisher), blockTime, txHash],
  );
};

const issuanceRequested: Projection<{
  id: bigint;
  institution: Hex;
  amount: bigint;
  fundingRef: Hex;
  maker: Address;
}> = async (db, { args, blockTime, txHash }) => {
  await db.query(
    `INSERT INTO issuance_requests (id, institution_id, amount, funding_ref, status, maker, requested_at, tx_hash)
     VALUES ($1, $2, $3, $4, 'Pending', $5, $6, $7)`,
    [args.id, fromCode(args.institution), args.amount, fromCode(args.fundingRef), lower(args.maker), blockTime, txHash],
  );
};

const issuanceApproved: Projection<{ id: bigint; checker: Address }> = async (db, { args, blockTime }) => {
  await db.query("UPDATE issuance_requests SET status = 'Completed', checker = $2, decided_at = $3 WHERE id = $1", [
    args.id,
    lower(args.checker),
    blockTime,
  ]);
};

const issuanceRejected: Projection<{ id: bigint; reason: Hex; checker: Address }> = async (db, { args, blockTime }) => {
  await db.query(
    "UPDATE issuance_requests SET status = 'Rejected', checker = $2, reason = $3, decided_at = $4 WHERE id = $1",
    [args.id, lower(args.checker), fromCode(args.reason), blockTime],
  );
};

const redemptionRequested: Projection<{
  id: bigint;
  institution: Hex;
  account: Address;
  amount: bigint;
  payoutRef: Hex;
}> = async (db, { args, blockTime, txHash }) => {
  await db.query(
    `INSERT INTO redemption_requests (id, institution_id, account, amount, payout_ref, status, requested_at, tx_hash)
     VALUES ($1, $2, $3, $4, $5, 'Pending', $6, $7)`,
    [
      args.id,
      fromCode(args.institution),
      lower(args.account),
      args.amount,
      fromCode(args.payoutRef),
      blockTime,
      txHash,
    ],
  );
};

const redemptionSettled: Projection<{ id: bigint; checker: Address }> = async (db, { args, blockTime }) => {
  await db.query("UPDATE redemption_requests SET status = 'Completed', checker = $2, decided_at = $3 WHERE id = $1", [
    args.id,
    lower(args.checker),
    blockTime,
  ]);
};

const redemptionRejected: Projection<{ id: bigint; reason: Hex; checker: Address }> = async (
  db,
  { args, blockTime },
) => {
  await db.query(
    "UPDATE redemption_requests SET status = 'Rejected', checker = $2, reason = $3, decided_at = $4 WHERE id = $1",
    [args.id, lower(args.checker), fromCode(args.reason), blockTime],
  );
};

export const reserveProjections = {
  ReserveStatementPublished: statementPublished,
  IssuanceRequested: issuanceRequested,
  IssuanceApproved: issuanceApproved,
  IssuanceRejected: issuanceRejected,
  RedemptionRequested: redemptionRequested,
  RedemptionSettled: redemptionSettled,
  RedemptionRejected: redemptionRejected,
} as ProjectionMap;
