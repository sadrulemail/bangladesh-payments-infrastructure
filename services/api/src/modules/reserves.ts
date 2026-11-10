/** Reserve statements, issuance and redemption of tBDT. */
import { instructions, toCode, toReference } from "@takarail/sdk";
import type { FastifyInstance } from "fastify";
import { type Hex, keccak256, stringToHex } from "viem";
import { z } from "zod";

import { settlementSignerOf, signerOfOperator } from "../chain/custody";
import { contracts, publicClient } from "../chain/network";
import { pool, query, queryOne } from "../db/pool";
import { execute } from "../http/commands";
import { route } from "../http/route";
import { idParams, reference, shortCode, takaAmount } from "../http/schemas";

const decision = z.object({ reason: reference });

export function reserveRoutes(app: FastifyInstance): void {
  route(app, {
    method: "GET",
    url: "/v1/reserves",
    tag: "Reserves",
    summary: "Supply against the reserve, with statements, issuance and redemption requests",
    access: "operator",
    handler: async () => {
      const [totalSupply, statements, issuance, redemptions] = await Promise.all([
        publicClient.readContract({ ...contracts.token, functionName: "totalSupply" }),
        query(
          pool,
          `SELECT idx, as_of, balance, document_hash, publisher, published_at, tx_hash
             FROM reserve_statements
            ORDER BY idx DESC
            LIMIT 30`,
        ),
        query(
          pool,
          `SELECT r.id, r.institution_id, i.name AS institution_name, r.amount, r.funding_ref, r.status,
                  r.maker, r.checker, r.reason, r.requested_at, r.decided_at, r.tx_hash
             FROM issuance_requests r
             JOIN institutions i ON i.id = r.institution_id
            ORDER BY r.id DESC
            LIMIT 60`,
        ),
        query(
          pool,
          `SELECT r.id, r.institution_id, i.name AS institution_name, r.amount, r.payout_ref, r.status,
                  r.checker, r.reason, r.requested_at, r.decided_at, r.tx_hash
             FROM redemption_requests r
             JOIN institutions i ON i.id = r.institution_id
            ORDER BY r.id DESC
            LIMIT 60`,
        ),
      ]);
      return { totalSupply, statements, issuance, redemptions };
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/reserves/statements",
    tag: "Reserves",
    summary: "Publish the balance of the reserve trust account",
    access: ["reserve_auditor"],
    body: z.object({
      balance: takaAmount,
      /** Name or reference of the signed statement. Its hash is recorded on chain. */
      document: z.string().trim().min(3).max(200),
    }),
    handler: async ({ body, operator }) => {
      // The statement is dated at the head of the chain: the contract accepts no later date.
      const block = await publicClient.getBlock();
      const documentHash: Hex = keccak256(stringToHex(body.document));
      return execute(
        operator,
        "reserve.statement",
        { balance: body.balance, document: body.document },
        signerOfOperator(operator),
        {
          ...contracts.controller,
          functionName: "publishReserveStatement",
          args: [block.timestamp, body.balance, documentHash],
        },
      );
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/reserves/issuance",
    tag: "Reserves",
    summary: "Record taka received in the trust account and request the matching issuance",
    access: ["issuance_maker"],
    body: z.object({ institution: shortCode, amount: takaAmount, fundingRef: reference }),
    handler: async ({ body, operator }) =>
      execute(operator, "issuance.request", body, signerOfOperator(operator), {
        ...contracts.controller,
        functionName: "requestIssuance",
        args: [toCode(body.institution), body.amount, toReference(body.fundingRef)],
      }),
  });

  route(app, {
    method: "POST",
    url: "/v1/reserves/issuance/:id/approve",
    tag: "Reserves",
    summary: "Approve an issuance request and mint to the institution",
    access: ["reserve_checker"],
    params: idParams,
    handler: async ({ params, operator }) =>
      execute(operator, "issuance.approve", { id: params.id }, signerOfOperator(operator), {
        ...contracts.controller,
        functionName: "approveIssuance",
        args: [params.id],
      }),
  });

  route(app, {
    method: "POST",
    url: "/v1/reserves/issuance/:id/reject",
    tag: "Reserves",
    summary: "Reject an issuance request",
    access: ["reserve_checker"],
    params: idParams,
    body: decision,
    handler: async ({ params, body, operator }) =>
      execute(operator, "issuance.reject", { id: params.id, reason: body.reason }, signerOfOperator(operator), {
        ...contracts.controller,
        functionName: "rejectIssuance",
        args: [params.id, toReference(body.reason)],
      }),
  });

  route(app, {
    method: "POST",
    url: "/v1/reserves/redemptions",
    tag: "Reserves",
    summary: "Send tBDT from the institution's settlement account for redemption into taka",
    access: ["institution_admin", "exchange_house", "treasury"],
    body: z.object({ amount: takaAmount, payoutRef: reference }),
    handler: async ({ body, operator }) =>
      execute(operator, "redemption.request", body, await settlementSignerOf(operator), {
        ...contracts.token,
        functionName: "transferAndCall",
        args: [contracts.controller.address, body.amount, instructions.redemption(body.payoutRef)],
      }),
  });

  route(app, {
    method: "POST",
    url: "/v1/reserves/redemptions/:id/settle",
    tag: "Reserves",
    summary: "Confirm the taka payout of a redemption and burn the tBDT",
    access: ["reserve_checker"],
    params: idParams,
    handler: async ({ params, operator }) =>
      execute(operator, "redemption.settle", { id: params.id }, signerOfOperator(operator), {
        ...contracts.controller,
        functionName: "settleRedemption",
        args: [params.id],
      }),
  });

  route(app, {
    method: "POST",
    url: "/v1/reserves/redemptions/:id/reject",
    tag: "Reserves",
    summary: "Reject a redemption and return the tBDT to the institution",
    access: ["reserve_checker"],
    params: idParams,
    body: decision,
    handler: async ({ params, body, operator }) =>
      execute(operator, "redemption.reject", { id: params.id, reason: body.reason }, signerOfOperator(operator), {
        ...contracts.controller,
        functionName: "rejectRedemption",
        args: [params.id, toReference(body.reason)],
      }),
  });

  route(app, {
    method: "GET",
    url: "/v1/reserves/coverage",
    tag: "Reserves",
    summary: "Daily supply against the reserve statement in force on that day",
    access: "operator",
    handler: async () => {
      const supply = await queryOne<{ supply: string }>(
        pool,
        "SELECT COALESCE(SUM(balance), 0)::bigint AS supply FROM ledger_balances WHERE wallet IS NOT NULL",
      );
      const days = await query(
        pool,
        `WITH movement AS (
             SELECT dhaka_date(e.posted_at) AS business_date,
                    SUM(CASE e.entry_type WHEN 'issuance' THEN l.debit WHEN 'redemption' THEN -l.credit ELSE 0 END) AS change
               FROM journal_entries e
               JOIN journal_lines l ON l.entry_id = e.id
               JOIN ledger_accounts a ON a.id = l.account_id AND a.code = '1000'
              GROUP BY 1
         ),
         calendar AS (
             SELECT generate_series(
                        (SELECT MIN(business_date) FROM movement),
                        dhaka_date(COALESCE((SELECT block_time FROM indexer_cursor WHERE id = 1), now())),
                        interval '1 day')::date AS business_date
         )
         SELECT c.business_date::text AS business_date,
                SUM(COALESCE(m.change, 0)) OVER (ORDER BY c.business_date)::bigint AS supply,
                (SELECT s.balance FROM reserve_statements s
                  WHERE dhaka_date(s.published_at) <= c.business_date
                  ORDER BY s.idx DESC LIMIT 1) AS reserve
           FROM calendar c
           LEFT JOIN movement m ON m.business_date = c.business_date
          WHERE c.business_date IS NOT NULL
          ORDER BY c.business_date`,
      );
      return { supply: supply?.supply ?? "0", days };
    },
  });
}
