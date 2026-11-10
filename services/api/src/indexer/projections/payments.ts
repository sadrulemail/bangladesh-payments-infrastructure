import { fromAscii, fromCode } from "@takarail/sdk";
import type { Address, Hex } from "viem";

import { type Projection, type ProjectionMap, lower } from "../types";

const merchantRegistered: Projection<{
  merchantId: Hex;
  acquirer: Hex;
  account: Address;
  categoryCode: number;
}> = async (db, { args, blockTime }) => {
  await db.query(
    `INSERT INTO merchants (id, acquirer_id, account, category_code, registered_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [fromCode(args.merchantId), fromCode(args.acquirer), lower(args.account), args.categoryCode, blockTime],
  );
};

const merchantStatusChanged: Projection<{ merchantId: Hex; active: boolean }> = async (db, { args }) => {
  await db.query("UPDATE merchants SET active = $2 WHERE id = $1", [fromCode(args.merchantId), args.active]);
};

const feeScheduleChanged: Projection<{ defaultFeeBps: number; acquirerShareBps: number }> = async (db, { args }) => {
  await db.query(
    `INSERT INTO fee_schedule (id, default_fee_bps, acquirer_share_bps)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE
       SET default_fee_bps = EXCLUDED.default_fee_bps, acquirer_share_bps = EXCLUDED.acquirer_share_bps`,
    [args.defaultFeeBps, args.acquirerShareBps],
  );
};

const categoryFeeChanged: Projection<{ categoryCode: number; set: boolean; feeBps: number }> = async (db, { args }) => {
  if (!args.set) {
    await db.query("DELETE FROM category_fees WHERE category_code = $1", [args.categoryCode]);
    return;
  }
  await db.query(
    `INSERT INTO category_fees (category_code, fee_bps)
     VALUES ($1, $2)
     ON CONFLICT (category_code) DO UPDATE SET fee_bps = EXCLUDED.fee_bps`,
    [args.categoryCode, args.feeBps],
  );
};

const merchantPaymentSettled: Projection<{
  paymentId: bigint;
  merchantId: Hex;
  payer: Address;
  payee: Address;
  amount: bigint;
  acquirerFee: bigint;
  networkFee: bigint;
  invoiceRef: Hex;
}> = async (db, { args, blockTime, txHash }) => {
  await db.query(
    `INSERT INTO payments
       (id, kind, payer, payee, merchant_id, amount, acquirer_fee, network_fee, reference, settled_at, tx_hash)
     VALUES ($1, 'merchant', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      args.paymentId,
      lower(args.payer),
      lower(args.payee),
      fromCode(args.merchantId),
      args.amount,
      args.acquirerFee,
      args.networkFee,
      fromCode(args.invoiceRef) || null,
      blockTime,
      txHash,
    ],
  );
};

const personTransferSettled: Projection<{
  paymentId: bigint;
  payer: Address;
  payee: Address;
  amount: bigint;
  endToEndRef: Hex;
  purpose: Hex;
}> = async (db, { args, blockTime, txHash }) => {
  await db.query(
    `INSERT INTO payments (id, kind, payer, payee, amount, reference, purpose, settled_at, tx_hash)
     VALUES ($1, 'person', $2, $3, $4, $5, $6, $7, $8)`,
    [
      args.paymentId,
      lower(args.payer),
      lower(args.payee),
      args.amount,
      fromCode(args.endToEndRef) || null,
      fromAscii(args.purpose),
      blockTime,
      txHash,
    ],
  );
};

const paymentRefunded: Projection<{ paymentId: bigint; amount: bigint; refundedTotal: bigint }> = async (
  db,
  { args, blockTime, txHash },
) => {
  await db.query("UPDATE payments SET refunded = $2 WHERE id = $1", [args.paymentId, args.refundedTotal]);
  await db.query("INSERT INTO refunds (payment_id, amount, refunded_at, tx_hash) VALUES ($1, $2, $3, $4)", [
    args.paymentId,
    args.amount,
    blockTime,
    txHash,
  ]);
};

export const paymentProjections = {
  MerchantRegistered: merchantRegistered,
  MerchantStatusChanged: merchantStatusChanged,
  FeeScheduleChanged: feeScheduleChanged,
  CategoryFeeChanged: categoryFeeChanged,
  MerchantPaymentSettled: merchantPaymentSettled,
  PersonTransferSettled: personTransferSettled,
  PaymentRefunded: paymentRefunded,
} as ProjectionMap;
