/** The double-entry ledger and its reconciliation against the chain. */
import type { FastifyInstance } from "fastify";

import { pool, query, queryOne } from "../db/pool";
import { route } from "../http/route";
import { pagination } from "../http/schemas";
import { reconcile } from "../ledger/reconciliation";

export function ledgerRoutes(app: FastifyInstance): void {
  route(app, {
    method: "GET",
    url: "/v1/ledger/trial-balance",
    tag: "Ledger",
    summary: "Reserve asset against wallet liabilities, by institution and tier",
    access: "operator",
    handler: async () => {
      const [totals, liabilities] = await Promise.all([
        queryOne(
          pool,
          `SELECT COALESCE(SUM(balance) FILTER (WHERE category = 'asset'), 0)::bigint     AS assets,
                  COALESCE(SUM(balance) FILTER (WHERE category = 'liability'), 0)::bigint AS liabilities,
                  COALESCE(SUM(debit), 0)::bigint  AS total_debits,
                  COALESCE(SUM(credit), 0)::bigint AS total_credits,
                  (SELECT COUNT(*) FROM journal_entries)::int AS entries
             FROM ledger_balances`,
        ),
        query(
          pool,
          `SELECT a.institution_id, i.name AS institution_name, a.tier,
                  COUNT(*)::int AS wallets, COALESCE(SUM(b.balance), 0)::bigint AS balance
             FROM ledger_balances b
             JOIN accounts a ON a.address = b.wallet
             JOIN institutions i ON i.id = a.institution_id
            GROUP BY a.institution_id, i.name, a.tier
            ORDER BY i.name, a.tier`,
        ),
      ]);
      return { totals, liabilities };
    },
  });

  route(app, {
    method: "GET",
    url: "/v1/ledger/journal",
    tag: "Ledger",
    summary: "Journal entries with the accounts they debit and credit",
    access: "operator",
    query: pagination,
    handler: async ({ query: page }) =>
      query(
        pool,
        `SELECT e.id, e.entry_type, e.block_number, e.posted_at, e.tx_hash,
                dl.debit AS amount,
                da.code AS debit_code, COALESCE(dp.label, da.name) AS debit_account,
                ca.code AS credit_code, COALESCE(cp.label, ca.name) AS credit_account
           FROM journal_entries e
           JOIN journal_lines dl ON dl.entry_id = e.id AND dl.debit > 0
           JOIN journal_lines cl ON cl.entry_id = e.id AND cl.credit > 0
           JOIN ledger_accounts da ON da.id = dl.account_id
           JOIN ledger_accounts ca ON ca.id = cl.account_id
           LEFT JOIN account_profiles dp ON dp.address = da.wallet
           LEFT JOIN account_profiles cp ON cp.address = ca.wallet
          ORDER BY e.id DESC
          LIMIT $1 OFFSET $2`,
        [page.limit, page.offset],
      ),
  });

  route(app, {
    method: "GET",
    url: "/v1/reconciliation",
    tag: "Ledger",
    summary: "Recent reconciliation runs",
    access: "operator",
    handler: async () => query(pool, "SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 20"),
  });

  route(app, {
    method: "POST",
    url: "/v1/reconciliation",
    tag: "Ledger",
    summary: "Reconcile the ledger against chain balances and the reserve statement now",
    access: ["reserve_auditor", "network_operator", "supervisor"],
    handler: async ({ operator }) => reconcile(operator.username),
  });
}
