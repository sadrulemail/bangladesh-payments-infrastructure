/** Network status and the figures of the console's overview page. */
import type { FastifyInstance } from "fastify";

import { deployment } from "../chain/network";
import { config } from "../config";
import { pool, query, queryOne } from "../db/pool";
import { route } from "../http/route";
import { indexer } from "../indexer/indexer";

const ACTIVITY_FEED = `
  SELECT 'merchant_payment' AS type, p.settled_at AS at, p.tx_hash, p.amount,
         COALESCE(payer.label, p.payer) AS actor, COALESCE(mp.name, p.merchant_id) AS counterparty
    FROM payments p
    LEFT JOIN account_profiles payer ON payer.address = p.payer
    LEFT JOIN merchant_profiles mp ON mp.id = p.merchant_id
   WHERE p.kind = 'merchant'
  UNION ALL
  SELECT 'person_transfer', p.settled_at, p.tx_hash, p.amount,
         COALESCE(payer.label, p.payer), COALESCE(payee.label, p.payee)
    FROM payments p
    LEFT JOIN account_profiles payer ON payer.address = p.payer
    LEFT JOIN account_profiles payee ON payee.address = p.payee
   WHERE p.kind = 'person'
  UNION ALL
  SELECT 'remittance_' || lower(r.status), COALESCE(r.settled_at, r.created_at),
         COALESCE(r.settlement_tx_hash, r.tx_hash), r.amount, o.name, COALESCE(bp.label, r.beneficiary)
    FROM remittances r
    JOIN institutions o ON o.id = r.originator_id
    LEFT JOIN account_profiles bp ON bp.address = r.beneficiary
  UNION ALL
  SELECT 'issuance', r.decided_at, r.tx_hash, r.amount, i.name, 'Reserve controller'
    FROM issuance_requests r
    JOIN institutions i ON i.id = r.institution_id
   WHERE r.status = 'Completed'
  UNION ALL
  SELECT 'redemption', r.decided_at, r.tx_hash, r.amount, i.name, 'Reserve controller'
    FROM redemption_requests r
    JOIN institutions i ON i.id = r.institution_id
   WHERE r.status = 'Completed'
  UNION ALL
  SELECT 'disbursement', b.created_at, b.tx_hash, b.total, COALESCE(pp.label, b.payer),
         b.payout_count || ' payouts'
    FROM disbursement_batches b
    LEFT JOIN account_profiles pp ON pp.address = b.payer`;

export function overviewRoutes(app: FastifyInstance): void {
  route(app, {
    method: "GET",
    url: "/v1/network",
    tag: "Network",
    summary: "Chain, contract addresses and indexer position",
    access: "public",
    handler: async () => {
      const cursor = await queryOne<{ blockNumber: string; blockTime: string | null }>(
        pool,
        "SELECT block_number, block_time FROM indexer_cursor WHERE id = 1",
      );
      return {
        chainId: deployment.chainId,
        contracts: deployment.contracts,
        indexedBlock: cursor?.blockNumber ?? indexer.position.toString(),
        indexedBlockTime: cursor?.blockTime ?? null,
        confirmations: config.chain.confirmations,
      };
    },
  });

  route(app, {
    method: "GET",
    url: "/v1/overview",
    tag: "Network",
    summary: "Headline figures, daily activity and work waiting for a decision",
    access: "operator",
    handler: async () => {
      const [headline, today, series, corridors, pending, reconciliation, activity] = await Promise.all([
        queryOne(
          pool,
          `SELECT (SELECT COALESCE(SUM(balance), 0) FROM ledger_balances WHERE wallet IS NOT NULL)::bigint AS supply,
                  (SELECT balance FROM reserve_statements ORDER BY idx DESC LIMIT 1)           AS reserve,
                  (SELECT as_of FROM reserve_statements ORDER BY idx DESC LIMIT 1)             AS reserve_as_of,
                  (SELECT incentive_pool FROM gateway_policy WHERE id = 1)                     AS incentive_pool,
                  (SELECT COUNT(*) FROM institutions WHERE active)::int                        AS institutions,
                  (SELECT COUNT(*) FROM accounts
                    WHERE status = 'Active' AND tier NOT IN ('Institution', 'System'))::int    AS active_accounts,
                  (SELECT COUNT(*) FROM merchants WHERE active)::int                           AS merchants,
                  (SELECT block_number FROM indexer_cursor WHERE id = 1)                       AS indexed_block,
                  (SELECT block_time FROM indexer_cursor WHERE id = 1)                         AS indexed_block_time`,
        ),
        queryOne(
          pool,
          `SELECT d.*
             FROM daily_activity d
            WHERE d.business_date = dhaka_date(COALESCE((SELECT block_time FROM indexer_cursor WHERE id = 1), now()))`,
        ),
        query(
          pool,
          `SELECT business_date::text AS business_date, merchant_payments::int, merchant_volume,
                  person_transfers::int, transfer_volume, remittances::int, remittance_volume,
                  disbursements::int, disbursement_volume
             FROM daily_activity
            ORDER BY business_date DESC
            LIMIT 14`,
        ),
        query(
          pool,
          `SELECT r.corridor_id, c.currency, COUNT(*)::int AS remittances, SUM(r.amount)::bigint AS amount
             FROM remittances r
             JOIN corridors c ON c.id = r.corridor_id
            WHERE r.status = 'Paid'
            GROUP BY r.corridor_id, c.currency
            ORDER BY amount DESC`,
        ),
        queryOne(
          pool,
          `SELECT (SELECT COUNT(*) FROM issuance_requests WHERE status = 'Pending')::int              AS issuance,
                  (SELECT COUNT(*) FROM redemption_requests WHERE status = 'Pending')::int            AS redemptions,
                  (SELECT COUNT(*) FROM remittances WHERE status = 'UnderReview')::int                AS remittances,
                  (SELECT COUNT(*) FROM disbursement_batches WHERE status = 'AwaitingApproval')::int  AS batches,
                  (SELECT COUNT(*) FROM accounts WHERE status = 'Frozen')::int                        AS frozen_accounts`,
        ),
        queryOne(pool, "SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 1"),
        query(pool, `SELECT * FROM (${ACTIVITY_FEED}) feed WHERE at IS NOT NULL ORDER BY at DESC LIMIT 14`),
      ]);
      return {
        headline,
        today: today ?? null,
        series: series.reverse(),
        corridors,
        pending,
        reconciliation: reconciliation ?? null,
        activity,
      };
    },
  });
}
