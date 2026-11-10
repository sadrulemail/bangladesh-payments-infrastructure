/** Inward remittance corridors: rates, origination, compliance review and the incentive pool. */
import { REMITTANCE_STATUSES, basisPoints, convertToTaka, instructions, toCode, toReference } from "@takarail/sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { type Operator, settlementSignerOf, signerOfOperator } from "../chain/custody";
import { contracts } from "../chain/network";
import { pool, query, queryOne } from "../db/pool";
import { execute } from "../http/commands";
import { route } from "../http/route";
import {
  address,
  exchangeRate,
  idParams,
  pagination,
  purposeCode,
  reference,
  shortCode,
  sourceAmount,
  takaAmount,
} from "../http/schemas";
import { badRequest, forbidden, notFound } from "../lib/errors";

interface CorridorRate {
  id: string;
  currency: string;
  referenceRate: string | null;
}

async function requireCorridor(id: string): Promise<CorridorRate> {
  const corridor = await queryOne<CorridorRate>(
    pool,
    "SELECT id, currency, reference_rate FROM corridors WHERE id = $1",
    [id],
  );
  if (!corridor) throw notFound(`Corridor ${id}`);
  return corridor;
}

async function incentiveBps(): Promise<number> {
  const policy = await queryOne<{ incentiveBps: number }>(
    pool,
    "SELECT incentive_bps FROM gateway_policy WHERE id = 1",
  );
  return policy?.incentiveBps ?? 0;
}

/** An exchange house may only act on the remittances it originated. */
async function requireOwnRemittance(operator: Operator, id: bigint): Promise<void> {
  const remittance = await queryOne<{ originatorId: string }>(
    pool,
    "SELECT originator_id FROM remittances WHERE id = $1",
    [id],
  );
  if (!remittance) throw notFound(`Remittance ${id}`);
  if (remittance.originatorId !== operator.institutionId) {
    throw forbidden("This remittance was originated by another exchange house");
  }
}

export function remittanceRoutes(app: FastifyInstance): void {
  route(app, {
    method: "GET",
    url: "/v1/corridors",
    tag: "Remittances",
    summary: "Corridors with their reference rate, originators and settled volume",
    access: "operator",
    handler: async () =>
      query(
        pool,
        `SELECT c.id, c.currency, c.active, c.max_amount, c.reference_rate, c.rate_updated_at,
                COALESCE((SELECT json_agg(json_build_object('id', i.id, 'name', i.name) ORDER BY i.id)
                            FROM corridor_originators o
                            JOIN institutions i ON i.id = o.institution_id
                           WHERE o.corridor_id = c.id), '[]'::json) AS originators,
                COUNT(r.id) FILTER (WHERE r.status = 'Paid')::int AS paid_count,
                COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'Paid'), 0)::bigint AS paid_amount,
                COALESCE(SUM(r.source_amount) FILTER (WHERE r.status = 'Paid'), 0)::bigint AS paid_source_amount,
                COUNT(r.id) FILTER (WHERE r.status = 'UnderReview')::int AS under_review
           FROM corridors c
           LEFT JOIN remittances r ON r.corridor_id = c.id
          GROUP BY c.id
          ORDER BY c.id`,
      ),
  });

  route(app, {
    method: "GET",
    url: "/v1/corridors/:id/rates",
    tag: "Remittances",
    summary: "History of the reference rate of a corridor",
    access: "operator",
    params: z.object({ id: shortCode }),
    handler: async ({ params }) =>
      query(
        pool,
        `SELECT rate, publisher, published_at, tx_hash
           FROM reference_rates
          WHERE corridor_id = $1
          ORDER BY published_at DESC
          LIMIT 60`,
        [params.id],
      ),
  });

  route(app, {
    method: "POST",
    url: "/v1/corridors/:id/rate",
    tag: "Remittances",
    summary: "Publish the reference rate of a corridor",
    access: ["issuance_maker"],
    params: z.object({ id: shortCode }),
    body: z.object({ rate: exchangeRate }),
    handler: async ({ params, body, operator }) => {
      await requireCorridor(params.id);
      return execute(operator, "corridor.rate", { corridor: params.id, rate: body.rate }, signerOfOperator(operator), {
        ...contracts.gateway,
        functionName: "publishRate",
        args: [toCode(params.id), body.rate],
      });
    },
  });

  route(app, {
    method: "GET",
    url: "/v1/remittances",
    tag: "Remittances",
    summary: "Remittances, most recent first",
    access: "operator",
    query: pagination.extend({
      status: z.enum(REMITTANCE_STATUSES).exclude(["None"]).optional(),
      corridor: shortCode.optional(),
    }),
    handler: async ({ query: filter }) =>
      query(
        pool,
        `SELECT r.id, r.corridor_id, c.currency, r.originator_id, o.name AS originator_name,
                r.beneficiary, bp.label AS beneficiary_label, bp.district AS beneficiary_district,
                ba.institution_id AS beneficiary_institution,
                r.amount, r.incentive, r.incentive_paid, r.source_amount, r.rate, r.purpose, r.sender_ref,
                r.status, r.reason, r.created_at, r.settled_at, r.tx_hash, r.settlement_tx_hash
           FROM remittances r
           JOIN corridors c ON c.id = r.corridor_id
           JOIN institutions o ON o.id = r.originator_id
           LEFT JOIN account_profiles bp ON bp.address = r.beneficiary
           LEFT JOIN accounts ba ON ba.address = r.beneficiary
          WHERE ($1::text IS NULL OR r.status = $1)
            AND ($2::text IS NULL OR r.corridor_id = $2)
          ORDER BY r.id DESC
          LIMIT $3 OFFSET $4`,
        [filter.status ?? null, filter.corridor ?? null, filter.limit, filter.offset],
      ),
  });

  route(app, {
    method: "GET",
    url: "/v1/remittances/quote",
    tag: "Remittances",
    summary: "Payout and incentive for a source amount at the reference rate",
    access: "operator",
    query: z.object({ corridor: shortCode, sourceAmount }),
    handler: async ({ query: input }) => {
      const corridor = await requireCorridor(input.corridor);
      if (corridor.referenceRate === null) throw badRequest("The corridor has no reference rate yet");

      const amount = convertToTaka(input.sourceAmount, BigInt(corridor.referenceRate));
      return {
        corridor: corridor.id,
        currency: corridor.currency,
        sourceAmount: input.sourceAmount,
        rate: corridor.referenceRate,
        amount,
        incentive: basisPoints(amount, await incentiveBps()),
      };
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/remittances",
    tag: "Remittances",
    summary: "Originate a remittance from the exchange house's settlement account",
    access: ["exchange_house"],
    body: z.object({
      corridor: shortCode,
      beneficiary: address,
      sourceAmount,
      /** Rate given to the customer. Defaults to the reference rate of the corridor. */
      quotedRate: exchangeRate.optional(),
      purpose: purposeCode.default("FAMI"),
      senderRef: reference,
    }),
    handler: async ({ body, operator }) => {
      const corridor = await requireCorridor(body.corridor);
      const quotedRate =
        body.quotedRate ?? (corridor.referenceRate === null ? undefined : BigInt(corridor.referenceRate));
      if (quotedRate === undefined) throw badRequest("The corridor has no reference rate yet");

      const amount = convertToTaka(body.sourceAmount, quotedRate);
      const instruction = instructions.remittance({
        corridor: body.corridor,
        beneficiary: body.beneficiary,
        sourceAmount: body.sourceAmount,
        quotedRate,
        purpose: body.purpose,
        senderRef: body.senderRef,
      });
      return execute(
        operator,
        "remittance.originate",
        { ...body, quotedRate, amount },
        await settlementSignerOf(operator),
        {
          ...contracts.token,
          functionName: "transferAndCall",
          args: [contracts.gateway.address, amount, instruction],
        },
      );
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/remittances/:id/release",
    tag: "Remittances",
    summary: "Release a remittance held for review to its beneficiary",
    access: ["compliance_officer"],
    params: idParams,
    handler: async ({ params, operator }) =>
      execute(operator, "remittance.release", { id: params.id }, signerOfOperator(operator), {
        ...contracts.gateway,
        functionName: "release",
        args: [params.id],
      }),
  });

  route(app, {
    method: "POST",
    url: "/v1/remittances/:id/reject",
    tag: "Remittances",
    summary: "Reject a remittance held for review and return the principal to the originator",
    access: ["compliance_officer"],
    params: idParams,
    body: z.object({ reason: reference }),
    handler: async ({ params, body, operator }) =>
      execute(operator, "remittance.reject", { id: params.id, reason: body.reason }, signerOfOperator(operator), {
        ...contracts.gateway,
        functionName: "reject",
        args: [params.id, toReference(body.reason)],
      }),
  });

  route(app, {
    method: "POST",
    url: "/v1/remittances/:id/reclaim",
    tag: "Remittances",
    summary: "Take back a remittance that was not decided within the review window",
    access: ["exchange_house"],
    params: idParams,
    handler: async ({ params, operator }) => {
      await requireOwnRemittance(operator, params.id);
      return execute(operator, "remittance.reclaim", { id: params.id }, await settlementSignerOf(operator), {
        ...contracts.gateway,
        functionName: "reclaim",
        args: [params.id],
      });
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/remittances/incentive-pool",
    tag: "Remittances",
    summary: "Fund the remittance incentive pool from the Treasury account",
    access: ["treasury"],
    body: z.object({ amount: takaAmount }),
    handler: async ({ body, operator }) =>
      execute(operator, "incentive.fund", { amount: body.amount }, await settlementSignerOf(operator), {
        ...contracts.token,
        functionName: "transferAndCall",
        args: [contracts.gateway.address, body.amount, instructions.incentiveFunding()],
      }),
  });
}
