import { Link } from "react-router-dom";

import { ChartCard, ColumnChart, type ColumnPoint, RankedBars } from "../components/charts";
import { Card, type Column, DataTable, Loading, Money, PageHeader, Stat, StatusBadge, TxHash } from "../components/ui";
import { compactTaka, formatBusinessDay, formatDateTime, percentage, toTakaNumber } from "../lib/format";
import { useApi } from "../lib/hooks";
import type { ActivityItem, DailyActivity, Overview } from "../lib/types";

const RAILS = [
  { title: "Merchant payments", unit: "Payments", count: "merchantPayments", volume: "merchantVolume" },
  { title: "Person-to-person transfers", unit: "Transfers", count: "personTransfers", volume: "transferVolume" },
  { title: "Inward remittances", unit: "Remittances", count: "remittances", volume: "remittanceVolume" },
  { title: "Bulk disbursements", unit: "Payouts", count: "disbursements", volume: "disbursementVolume" },
] as const;

const ACTIVITY_LABELS: Record<string, string> = {
  merchant_payment: "Merchant payment",
  person_transfer: "Transfer",
  remittance_paid: "Remittance paid",
  remittance_underreview: "Remittance held",
  remittance_rejected: "Remittance rejected",
  remittance_reclaimed: "Remittance reclaimed",
  issuance: "Issuance",
  redemption: "Redemption",
  disbursement: "Disbursement batch",
};

const totalVolume = (day: DailyActivity) => RAILS.reduce((sum, rail) => sum + BigInt(day[rail.volume]), 0n);

const ACTIVITY_COLUMNS: Column<ActivityItem>[] = [
  { header: "When", cell: (item) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(item.at)}</span> },
  { header: "Event", cell: (item) => ACTIVITY_LABELS[item.type] ?? item.type },
  {
    header: "Parties",
    cell: (item) => (
      <span>
        {item.actor} <span className="text-ink-3">&rarr;</span> {item.counterparty}
      </span>
    ),
  },
  { header: "Amount", align: "right", cell: (item) => <Money value={item.amount} /> },
  { header: "Transaction", cell: (item) => <TxHash hash={item.txHash} /> },
];

export function OverviewPage() {
  const { data } = useApi<Overview>("/v1/overview", { refetchMs: 15_000 });
  if (!data) return <Loading />;

  const { headline, today, series, pending, reconciliation } = data;
  const reserve = headline.reserve ?? "0";
  const settledToday = today ? totalVolume(today) : 0n;
  const movementsToday = today ? RAILS.reduce((sum, rail) => sum + Number(today[rail.count]), 0) : 0;

  const waiting = [
    { label: "Remittances under review", count: pending.remittances, to: "/remittances" },
    { label: "Batches awaiting approval", count: pending.batches, to: "/disbursements" },
    { label: "Issuance requests", count: pending.issuance, to: "/reserves" },
    { label: "Redemption requests", count: pending.redemptions, to: "/reserves" },
    { label: "Frozen accounts", count: pending.frozenAccounts, to: "/directory" },
  ];

  return (
    <>
      <PageHeader
        title="Network overview"
        description="Tokenised taka in circulation, the reserve behind it and the value settled across the network."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="tBDT in circulation"
          value={compactTaka(headline.supply)}
          hint={<Money value={headline.supply} muted />}
        />
        <Stat
          label="Reserve cover"
          value={percentage(reserve, headline.supply)}
          hint={`Statement of ${compactTaka(reserve)}, as of ${formatDateTime(headline.reserveAsOf)}`}
        />
        <Stat
          label="Settled today"
          value={compactTaka(settledToday)}
          hint={`${movementsToday} movements on ${today ? formatBusinessDay(today.businessDate) : "this business day"}`}
        />
        <Stat
          label="Active wallets"
          value={headline.activeAccounts}
          hint={`${headline.institutions} institutions · ${headline.merchants} merchants`}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <ChartCard
          className="xl:col-span-2"
          title="Value settled per day"
          subtitle="Taka by rail and business day in Dhaka. Each panel has its own scale."
          table={
            <DataTable
              rowKey={(day) => day.businessDate}
              rows={series}
              columns={[
                { header: "Business day", cell: (day) => formatBusinessDay(day.businessDate) },
                ...RAILS.map((rail): Column<DailyActivity> => ({
                  header: rail.title,
                  align: "right",
                  cell: (day) => (
                    <span>
                      <Money value={day[rail.volume]} /> <span className="text-ink-3">({Number(day[rail.count])})</span>
                    </span>
                  ),
                })),
              ]}
            />
          }
        >
          <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
            {RAILS.map((rail) => (
              <ColumnChart
                key={rail.title}
                title={rail.title}
                unit={rail.unit}
                points={series.map((day): ColumnPoint => ({
                  label: formatBusinessDay(day.businessDate),
                  value: toTakaNumber(day[rail.volume]),
                  amount: day[rail.volume],
                  count: Number(day[rail.count]),
                }))}
              />
            ))}
          </div>
        </ChartCard>

        <div className="space-y-4">
          <Card title="Waiting for a decision" subtitle="Work that needs a second pair of eyes.">
            <ul className="divide-y divide-line">
              {waiting.map((item) => (
                <li key={item.label}>
                  <Link to={item.to} className="flex items-center justify-between py-2 text-sm hover:text-brand">
                    {item.label}
                    <span
                      className={`figures rounded-full px-2 text-xs leading-5 font-semibold ${
                        item.count > 0 ? "bg-warning text-ink" : "bg-sunken text-ink-3"
                      }`}
                    >
                      {item.count}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Reconciliation" subtitle="Ledger against chain balances and the reserve.">
            {reconciliation ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <StatusBadge status={reconciliation.status} />
                  <span className="text-xs text-ink-3">Block {reconciliation.blockNumber}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-2">Wallets checked</span>
                  <span className="figures">{reconciliation.walletsChecked}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-2">Ledger liabilities</span>
                  <Money value={reconciliation.ledgerLiabilities} />
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-2">Supply on chain</span>
                  <Money value={reconciliation.totalSupply} />
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-3">No run yet.</p>
            )}
          </Card>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title="Remittances by corridor" subtitle="Taka paid to beneficiaries since launch.">
          <RankedBars
            rows={data.corridors.map((corridor) => ({
              key: corridor.corridorId,
              label: corridor.corridorId,
              note: `${corridor.remittances} paid`,
              amount: corridor.amount,
            }))}
          />
        </Card>
        <Card className="xl:col-span-2" title="Recent activity" flush>
          <DataTable
            rowKey={(item) => `${item.txHash}-${item.type}`}
            rows={data.activity.slice(0, 8)}
            columns={ACTIVITY_COLUMNS}
          />
        </Card>
      </div>
    </>
  );
}
