import { fromAscii, fromCode } from "@takarail/sdk";
import type { Address, Hex } from "viem";

import { type Projection, type ProjectionMap, lower } from "../types";

const policyChanged: Projection<{
  incentiveBps: number;
  rateBandBps: number;
  rateValidity: number;
  reviewWindow: number;
  screeningThreshold: bigint;
}> = async (db, { args }) => {
  await db.query(
    `INSERT INTO gateway_policy (id, incentive_bps, rate_band_bps, rate_validity, review_window, screening_threshold)
     VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET incentive_bps       = EXCLUDED.incentive_bps,
           rate_band_bps       = EXCLUDED.rate_band_bps,
           rate_validity       = EXCLUDED.rate_validity,
           review_window       = EXCLUDED.review_window,
           screening_threshold = EXCLUDED.screening_threshold`,
    [args.incentiveBps, args.rateBandBps, args.rateValidity, args.reviewWindow, args.screeningThreshold],
  );
};

const corridorConfigured: Projection<{ corridor: Hex; currency: Hex; maxAmount: bigint; active: boolean }> = async (
  db,
  { args },
) => {
  await db.query(
    `INSERT INTO corridors (id, currency, active, max_amount)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET currency = EXCLUDED.currency, active = EXCLUDED.active, max_amount = EXCLUDED.max_amount`,
    [fromCode(args.corridor), fromAscii(args.currency), args.active, args.maxAmount],
  );
};

const originatorAuthorised: Projection<{ corridor: Hex; institution: Hex; authorised: boolean }> = async (
  db,
  { args },
) => {
  const key = [fromCode(args.corridor), fromCode(args.institution)];
  if (args.authorised) {
    await db.query(
      "INSERT INTO corridor_originators (corridor_id, institution_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      key,
    );
  } else {
    await db.query("DELETE FROM corridor_originators WHERE corridor_id = $1 AND institution_id = $2", key);
  }
};

const referenceRatePublished: Projection<{ corridor: Hex; rate: bigint; publisher: Address }> = async (
  db,
  { args, blockTime, txHash },
) => {
  const corridor = fromCode(args.corridor);
  await db.query("UPDATE corridors SET reference_rate = $2, rate_updated_at = $3 WHERE id = $1", [
    corridor,
    args.rate,
    blockTime,
  ]);
  await db.query(
    "INSERT INTO reference_rates (corridor_id, rate, publisher, published_at, tx_hash) VALUES ($1, $2, $3, $4, $5)",
    [corridor, args.rate, lower(args.publisher), blockTime, txHash],
  );
};

const incentivePoolFunded: Projection<{ pool: bigint }> = async (db, { args }) => {
  await db.query("UPDATE gateway_policy SET incentive_pool = $1 WHERE id = 1", [args.pool]);
};

const remittanceReceived: Projection<{
  id: bigint;
  corridor: Hex;
  originator: Hex;
  beneficiary: Address;
  amount: bigint;
  sourceAmount: bigint;
  rate: bigint;
  purpose: Hex;
  senderRef: Hex;
}> = async (db, { args, blockTime, txHash }) => {
  await db.query(
    `INSERT INTO remittances
       (id, corridor_id, originator_id, beneficiary, amount, source_amount, rate, purpose, sender_ref,
        status, created_at, tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'UnderReview', $10, $11)`,
    [
      args.id,
      fromCode(args.corridor),
      fromCode(args.originator),
      lower(args.beneficiary),
      args.amount,
      args.sourceAmount,
      args.rate,
      fromAscii(args.purpose),
      fromCode(args.senderRef),
      blockTime,
      txHash,
    ],
  );
};

const remittancePaid: Projection<{ id: bigint; incentive: bigint; incentivePaid: boolean }> = async (
  db,
  { args, blockTime, txHash },
) => {
  await db.query(
    `UPDATE remittances
        SET status = 'Paid', incentive = $2, incentive_paid = $3, settled_at = $4, settlement_tx_hash = $5
      WHERE id = $1`,
    [args.id, args.incentive, args.incentivePaid, blockTime, txHash],
  );
  if (args.incentivePaid) {
    await db.query("UPDATE gateway_policy SET incentive_pool = incentive_pool - $1 WHERE id = 1", [args.incentive]);
  }
};

const incentiveSettled: Projection<{ id: bigint; incentive: bigint }> = async (db, { args }) => {
  await db.query("UPDATE remittances SET incentive_paid = true WHERE id = $1", [args.id]);
  await db.query("UPDATE gateway_policy SET incentive_pool = incentive_pool - $1 WHERE id = 1", [args.incentive]);
};

const remittanceRejected: Projection<{ id: bigint; reason: Hex }> = async (db, { args, blockTime, txHash }) => {
  await db.query(
    `UPDATE remittances
        SET status = 'Rejected', reason = $2, settled_at = $3, settlement_tx_hash = $4
      WHERE id = $1`,
    [args.id, fromCode(args.reason), blockTime, txHash],
  );
};

const remittanceReclaimed: Projection<{ id: bigint }> = async (db, { args, blockTime, txHash }) => {
  await db.query(
    "UPDATE remittances SET status = 'Reclaimed', settled_at = $2, settlement_tx_hash = $3 WHERE id = $1",
    [args.id, blockTime, txHash],
  );
};

export const remittanceProjections = {
  PolicyChanged: policyChanged,
  CorridorConfigured: corridorConfigured,
  OriginatorAuthorised: originatorAuthorised,
  ReferenceRatePublished: referenceRatePublished,
  IncentivePoolFunded: incentivePoolFunded,
  RemittanceReceived: remittanceReceived,
  RemittancePaid: remittancePaid,
  IncentiveSettled: incentiveSettled,
  RemittanceRejected: remittanceRejected,
  RemittanceReclaimed: remittanceReclaimed,
} as ProjectionMap;
