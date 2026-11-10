/** Bulk payouts through the disbursement hub: wages and allowances. */
import { type PayoutEntry, buildPayoutTree, instructions, toReference } from "@takarail/sdk";
import type { FastifyInstance } from "fastify";
import type { Address } from "viem";
import { z } from "zod";

import { type Operator, signerOfOperator, signerOfWallet } from "../chain/custody";
import { contracts } from "../chain/network";
import { pool, query, queryOne } from "../db/pool";
import { execute } from "../http/commands";
import { route } from "../http/route";
import { address, idParams, purposeCode, reference, takaAmount } from "../http/schemas";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";

/** Payouts sent in one transaction. Keeps a chunk well inside the block gas limit. */
const PAYOUTS_PER_TRANSACTION = 40;

interface BatchRow {
  id: string;
  payer: string;
  payerInstitutionId: string;
  batchRef: string;
  status: string;
}

interface StoredPayout {
  index: number;
  account: Address;
  amount: string;
}

const BATCH_SELECT = `
  SELECT b.id, b.payer, pp.label AS payer_label, b.payer_institution_id, i.name AS payer_institution_name,
         b.batch_ref, b.merkle_root, b.total, b.paid, b.failed, b.returned, b.payout_count, b.processed,
         b.purpose, b.status, b.reason, b.created_at, b.approved_at, b.closed_at, b.tx_hash
    FROM disbursement_batches b
    JOIN institutions i ON i.id = b.payer_institution_id
    LEFT JOIN account_profiles pp ON pp.address = b.payer`;

/** Loads a batch and checks that it belongs to the operator's institution. */
async function requireOwnBatch(operator: Operator, id: bigint): Promise<BatchRow> {
  const batch = await queryOne<BatchRow>(
    pool,
    "SELECT id, payer, payer_institution_id, batch_ref, status FROM disbursement_batches WHERE id = $1",
    [id],
  );
  if (!batch) throw notFound(`Batch ${id}`);
  if (batch.payerInstitutionId !== operator.institutionId) {
    throw forbidden("This batch belongs to a customer of another institution");
  }
  return batch;
}

async function payoutList(batch: BatchRow): Promise<PayoutEntry[]> {
  const list = await queryOne<{ entries: StoredPayout[] }>(
    pool,
    "SELECT entries FROM disbursement_payout_lists WHERE payer = $1 AND batch_ref = $2",
    [batch.payer, batch.batchRef],
  );
  if (!list) throw conflict("The payout list of this batch is not held by this service");
  return list.entries.map((entry) => ({ index: entry.index, account: entry.account, amount: BigInt(entry.amount) }));
}

export function disbursementRoutes(app: FastifyInstance): void {
  route(app, {
    method: "GET",
    url: "/v1/disbursements",
    tag: "Disbursements",
    summary: "Disbursement batches, most recent first",
    access: "operator",
    handler: async () => query(pool, `${BATCH_SELECT} ORDER BY b.id DESC LIMIT 100`),
  });

  route(app, {
    method: "GET",
    url: "/v1/disbursements/:id",
    tag: "Disbursements",
    summary: "One batch with its payouts",
    access: "operator",
    params: idParams,
    handler: async ({ params }) => {
      const batch = await queryOne(pool, `${BATCH_SELECT} WHERE b.id = $1`, [params.id]);
      if (!batch) throw notFound(`Batch ${params.id}`);
      const payouts = await query(
        pool,
        `SELECT d.idx, d.account, p.label, a.institution_id, a.status AS account_status, d.amount, d.status,
                d.processed_at, d.tx_hash
           FROM disbursement_payouts d
           LEFT JOIN account_profiles p ON p.address = d.account
           LEFT JOIN accounts a ON a.address = d.account
          WHERE d.batch_id = $1
          ORDER BY d.idx`,
        [params.id],
      );
      return { ...batch, payouts };
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/disbursements",
    tag: "Disbursements",
    summary: "Fund a batch from a corporate wallet and commit to its payout list",
    access: ["institution_admin"],
    body: z.object({
      payer: address,
      batchRef: reference,
      purpose: purposeCode.default("SALA"),
      payouts: z
        .array(z.object({ account: address, amount: takaAmount }))
        .min(1)
        .max(5_000),
    }),
    handler: async ({ body, operator }) => {
      const signer = await signerOfWallet(operator, body.payer);
      const entries: PayoutEntry[] = body.payouts.map((payout, index) => ({ index, ...payout }));
      const tree = buildPayoutTree(entries);

      // The list is stored first: once the batch is on chain, its payouts can always be proven.
      const stored = await pool.query(
        `INSERT INTO disbursement_payout_lists (payer, batch_ref, entries)
         VALUES ($1, $2, $3)
         ON CONFLICT (payer, batch_ref) DO NOTHING`,
        [
          body.payer,
          body.batchRef,
          JSON.stringify(entries.map((entry) => ({ ...entry, amount: entry.amount.toString() }))),
        ],
      );
      if (stored.rowCount === 0) throw conflict(`Batch reference ${body.batchRef} was already used by this payer`);

      try {
        const result = await execute(
          operator,
          "disbursement.create",
          { payer: body.payer, batchRef: body.batchRef, total: tree.total, count: tree.count },
          signer,
          {
            ...contracts.token,
            functionName: "transferAndCall",
            args: [
              contracts.hub.address,
              tree.total,
              instructions.disbursementBatch({
                batchRef: body.batchRef,
                merkleRoot: tree.root,
                count: tree.count,
                purpose: body.purpose,
              }),
            ],
          },
        );
        return { ...result, merkleRoot: tree.root, total: tree.total, count: tree.count };
      } catch (error) {
        await pool.query("DELETE FROM disbursement_payout_lists WHERE payer = $1 AND batch_ref = $2", [
          body.payer,
          body.batchRef,
        ]);
        throw error;
      }
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/disbursements/:id/approve",
    tag: "Disbursements",
    summary: "Approve a batch on behalf of the payer's bank",
    access: ["institution_admin"],
    params: idParams,
    handler: async ({ params, operator }) => {
      await requireOwnBatch(operator, params.id);
      return execute(operator, "disbursement.approve", { id: params.id }, signerOfOperator(operator), {
        ...contracts.hub,
        functionName: "approve",
        args: [params.id],
      });
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/disbursements/:id/reject",
    tag: "Disbursements",
    summary: "Reject a batch and return its funds to the payer",
    access: ["institution_admin"],
    params: idParams,
    body: z.object({ reason: reference }),
    handler: async ({ params, body, operator }) => {
      await requireOwnBatch(operator, params.id);
      return execute(
        operator,
        "disbursement.reject",
        { id: params.id, reason: body.reason },
        signerOfOperator(operator),
        {
          ...contracts.hub,
          functionName: "reject",
          args: [params.id, toReference(body.reason)],
        },
      );
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/disbursements/:id/execute",
    tag: "Disbursements",
    summary: "Execute the next chunk of pending payouts of an approved batch",
    access: ["institution_admin"],
    params: idParams,
    handler: async ({ params, operator }) => {
      const batch = await requireOwnBatch(operator, params.id);
      if (batch.status !== "Approved") throw badRequest("Only an approved batch can be executed");

      const pending = await query<{ idx: number }>(
        pool,
        `SELECT idx FROM disbursement_payouts
          WHERE batch_id = $1 AND status = 'Pending'
          ORDER BY idx
          LIMIT $2`,
        [params.id, PAYOUTS_PER_TRANSACTION],
      );
      if (pending.length === 0) throw badRequest("Every payout of this batch has been processed");

      const entries = await payoutList(batch);
      const tree = buildPayoutTree(entries);
      const payouts = pending.map(({ idx }) => {
        const entry = entries[idx];
        if (!entry) throw conflict(`Payout ${idx} is missing from the stored list`);
        return { index: entry.index, account: entry.account, amount: entry.amount, proof: tree.proofFor(idx) };
      });

      const result = await execute(
        operator,
        "disbursement.execute",
        { id: params.id, payouts: payouts.length },
        signerOfOperator(operator),
        { ...contracts.hub, functionName: "execute", args: [params.id, payouts] },
      );
      const remaining = await queryOne<{ remaining: number }>(
        pool,
        "SELECT COUNT(*)::int AS remaining FROM disbursement_payouts WHERE batch_id = $1 AND status = 'Pending'",
        [params.id],
      );
      return { ...result, processed: payouts.length, remaining: remaining?.remaining ?? 0 };
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/disbursements/:id/close",
    tag: "Disbursements",
    summary: "Close a batch and return undelivered funds to the payer",
    access: ["institution_admin"],
    params: idParams,
    handler: async ({ params, operator }) => {
      await requireOwnBatch(operator, params.id);
      return execute(operator, "disbursement.close", { id: params.id }, signerOfOperator(operator), {
        ...contracts.hub,
        functionName: "close",
        args: [params.id],
      });
    },
  });
}
