/** Supervisory and settlement reports, as JSON or as CSV downloads. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { pool, query, queryOne } from "../db/pool";
import { route } from "../http/route";
import { isoDate } from "../http/schemas";
import { sendCsv } from "../lib/csv";

const format = z.enum(["json", "csv"]).default("json");

/** Business date in Dhaka at the head of the indexed chain. */
async function currentBusinessDate(): Promise<string> {
  const row = await queryOne<{ businessDate: string }>(
    pool,
    "SELECT dhaka_date(COALESCE((SELECT block_time FROM indexer_cursor WHERE id = 1), now()))::text AS business_date",
  );
  return row?.businessDate ?? new Date().toISOString().slice(0, 10);
}

export function reportRoutes(app: FastifyInstance): void {
  route(app, {
    method: "GET",
    url: "/v1/reports/settlement-positions",
    tag: "Reports",
    summary: "Position of every institution against the rest of the network for one business date",
    access: "operator",
    query: z.object({ date: isoDate.optional(), format }),
    handler: async ({ query: input, reply }) => {
      const date = input.date ?? (await currentBusinessDate());
      const positions = await query(
        pool,
        `SELECT i.id AS institution_id, i.name AS institution_name, i.kind,
                COALESCE(p.inflow, 0)::bigint AS inflow,
                COALESCE(p.outflow, 0)::bigint AS outflow,
                COALESCE(p.net_position, 0)::bigint AS net_position
           FROM institutions i
           LEFT JOIN settlement_positions p ON p.institution_id = i.id AND p.business_date = $1::date
          ORDER BY COALESCE(p.inflow, 0) + COALESCE(p.outflow, 0) DESC, i.name`,
        [date],
      );
      if (input.format === "csv") {
        return sendCsv(reply, `settlement-positions-${date}.csv`, positions, [
          "institutionId",
          "institutionName",
          "kind",
          "inflow",
          "outflow",
          "netPosition",
        ]);
      }

      const flows = await query(
        pool,
        `SELECT from_institution, to_institution, flow_type, COUNT(*)::int AS movements, SUM(amount)::bigint AS amount
           FROM settlement_flows
          WHERE dhaka_date(settled_at) = $1::date AND from_institution <> to_institution
          GROUP BY from_institution, to_institution, flow_type
          ORDER BY amount DESC`,
        [date],
      );
      const dates = await query<{ businessDate: string }>(
        pool,
        "SELECT DISTINCT business_date::text AS business_date FROM settlement_positions ORDER BY 1 DESC LIMIT 31",
      );
      return { date, dates: dates.map((row) => row.businessDate), positions, flows };
    },
  });

  route(app, {
    method: "GET",
    url: "/v1/reports/remittances",
    tag: "Reports",
    summary: "Inward remittances by corridor and business date",
    access: "operator",
    query: z.object({ from: isoDate.optional(), to: isoDate.optional(), format }),
    handler: async ({ query: input, reply }) => {
      const rows = await query(
        pool,
        `SELECT dhaka_date(r.settled_at)::text AS business_date, r.corridor_id, c.currency,
                r.originator_id, o.name AS originator_name,
                COUNT(*)::int AS remittances,
                SUM(r.source_amount)::bigint AS source_amount,
                SUM(r.amount)::bigint AS amount,
                SUM(r.incentive) FILTER (WHERE r.incentive_paid)::bigint AS incentive_paid
           FROM remittances r
           JOIN corridors c ON c.id = r.corridor_id
           JOIN institutions o ON o.id = r.originator_id
          WHERE r.status = 'Paid'
            AND ($1::date IS NULL OR dhaka_date(r.settled_at) >= $1::date)
            AND ($2::date IS NULL OR dhaka_date(r.settled_at) <= $2::date)
          GROUP BY 1, r.corridor_id, c.currency, r.originator_id, o.name
          ORDER BY 1 DESC, r.corridor_id`,
        [input.from ?? null, input.to ?? null],
      );
      if (input.format === "csv") {
        return sendCsv(reply, "inward-remittances.csv", rows, [
          "businessDate",
          "corridorId",
          "currency",
          "originatorId",
          "originatorName",
          "remittances",
          "sourceAmount",
          "amount",
          "incentivePaid",
        ]);
      }
      return rows;
    },
  });

  route(app, {
    method: "GET",
    url: "/v1/reports/beneficiary-districts",
    tag: "Reports",
    summary: "Inward remittances by district of the beneficiary",
    access: "operator",
    handler: async () =>
      query(
        pool,
        `SELECT COALESCE(p.district, 'Unknown') AS district, COUNT(*)::int AS remittances,
                SUM(r.amount)::bigint AS amount
           FROM remittances r
           LEFT JOIN account_profiles p ON p.address = r.beneficiary
          WHERE r.status = 'Paid'
          GROUP BY 1
          ORDER BY amount DESC`,
      ),
  });

  route(app, {
    method: "GET",
    url: "/v1/audit-log",
    tag: "Reports",
    summary: "Commands submitted by operators, accepted or rejected",
    access: ["supervisor", "network_operator", "reserve_auditor"],
    handler: async () =>
      query(
        pool,
        `SELECT l.id, l.operator, o.display_name, l.action, l.signer, l.details, l.outcome, l.tx_hash, l.error,
                l.created_at
           FROM audit_log l
           LEFT JOIN operators o ON o.username = l.operator
          ORDER BY l.id DESC
          LIMIT 150`,
      ),
  });
}
