-- Reporting views.

-- Business date in Dhaka (UTC+6) of a timestamp.
CREATE FUNCTION dhaka_date(moment timestamptz) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
    SELECT (moment AT TIME ZONE 'Asia/Dhaka')::date;
$$;

-- Value that moved from the customers of one institution to those of another, one row per movement.
-- Module wallets never appear here: each flow names the institutions at both ends.
CREATE VIEW settlement_flows AS
SELECT 'merchant_payment'::text       AS flow_type,
       p.settled_at                   AS settled_at,
       payer.institution_id           AS from_institution,
       payee.institution_id           AS to_institution,
       p.amount - p.acquirer_fee - p.network_fee AS amount
  FROM payments p
  JOIN accounts payer ON payer.address = p.payer
  JOIN accounts payee ON payee.address = p.payee
 WHERE p.kind = 'merchant'
UNION ALL
SELECT 'merchant_fee', p.settled_at, payer.institution_id, m.acquirer_id, p.acquirer_fee
  FROM payments p
  JOIN accounts payer ON payer.address = p.payer
  JOIN merchants m ON m.id = p.merchant_id
 WHERE p.kind = 'merchant' AND p.acquirer_fee > 0
UNION ALL
SELECT 'network_fee', p.settled_at, payer.institution_id, 'NETWORK', p.network_fee
  FROM payments p
  JOIN accounts payer ON payer.address = p.payer
 WHERE p.kind = 'merchant' AND p.network_fee > 0
UNION ALL
SELECT 'person_transfer', p.settled_at, payer.institution_id, payee.institution_id, p.amount
  FROM payments p
  JOIN accounts payer ON payer.address = p.payer
  JOIN accounts payee ON payee.address = p.payee
 WHERE p.kind = 'person'
UNION ALL
SELECT 'refund', r.refunded_at, payee.institution_id, payer.institution_id, r.amount
  FROM refunds r
  JOIN payments p ON p.id = r.payment_id
  JOIN accounts payer ON payer.address = p.payer
  JOIN accounts payee ON payee.address = p.payee
UNION ALL
SELECT 'remittance', r.settled_at, r.originator_id, beneficiary.institution_id, r.amount
  FROM remittances r
  JOIN accounts beneficiary ON beneficiary.address = r.beneficiary
 WHERE r.status = 'Paid'
UNION ALL
SELECT 'disbursement', d.processed_at, b.payer_institution_id, payee.institution_id, d.amount
  FROM disbursement_payouts d
  JOIN disbursement_batches b ON b.id = d.batch_id
  JOIN accounts payee ON payee.address = d.account
 WHERE d.status = 'Settled';

-- Daily position of every institution against the rest of the network.
CREATE VIEW settlement_positions AS
WITH legs AS (
    SELECT dhaka_date(settled_at) AS business_date, from_institution AS institution_id, 0::bigint AS inflow, amount AS outflow
      FROM settlement_flows
     WHERE from_institution <> to_institution
    UNION ALL
    SELECT dhaka_date(settled_at), to_institution, amount, 0::bigint
      FROM settlement_flows
     WHERE from_institution <> to_institution
)
SELECT business_date,
       institution_id,
       SUM(inflow)::bigint                AS inflow,
       SUM(outflow)::bigint               AS outflow,
       (SUM(inflow) - SUM(outflow))::bigint AS net_position
  FROM legs
 GROUP BY business_date, institution_id;

-- Daily activity of the network, one row per business date.
CREATE VIEW daily_activity AS
SELECT dhaka_date(settled_at) AS business_date,
       COUNT(*) FILTER (WHERE flow_type = 'merchant_payment')                   AS merchant_payments,
       COALESCE(SUM(amount) FILTER (WHERE flow_type IN ('merchant_payment', 'merchant_fee', 'network_fee')), 0)::bigint AS merchant_volume,
       COUNT(*) FILTER (WHERE flow_type = 'person_transfer')                    AS person_transfers,
       COALESCE(SUM(amount) FILTER (WHERE flow_type = 'person_transfer'), 0)::bigint AS transfer_volume,
       COUNT(*) FILTER (WHERE flow_type = 'remittance')                         AS remittances,
       COALESCE(SUM(amount) FILTER (WHERE flow_type = 'remittance'), 0)::bigint AS remittance_volume,
       COUNT(*) FILTER (WHERE flow_type = 'disbursement')                       AS disbursements,
       COALESCE(SUM(amount) FILTER (WHERE flow_type = 'disbursement'), 0)::bigint AS disbursement_volume
  FROM settlement_flows
 GROUP BY dhaka_date(settled_at);
