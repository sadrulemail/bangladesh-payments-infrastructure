import {
  Button,
  Card,
  type Column,
  DataTable,
  Money,
  PageHeader,
  RoleGate,
  Stat,
  StatusBadge,
  Tag,
  TxHash,
} from "../components/ui";
import { api, describeError } from "../lib/api";
import { compactTaka, formatDateTime } from "../lib/format";
import { useApi } from "../lib/hooks";
import { useToast } from "../lib/toast";
import type { JournalEntry, ReconciliationRun, TrialBalance } from "../lib/types";

const RECONCILERS = ["reserve_auditor", "network_operator", "supervisor"] as const;

const ENTRY_LABELS: Record<JournalEntry["entryType"], string> = {
  issuance: "Issuance",
  redemption: "Redemption",
  transfer: "Transfer",
};

const JOURNAL_COLUMNS: Column<JournalEntry>[] = [
  { header: "Entry", cell: (entry) => <span className="font-mono text-xs text-ink-3">{entry.id}</span> },
  {
    header: "Posted",
    cell: (entry) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(entry.postedAt)}</span>,
  },
  { header: "Type", cell: (entry) => <Tag>{ENTRY_LABELS[entry.entryType]}</Tag> },
  {
    header: "Debit",
    cell: (entry) => (
      <span>
        {entry.debitAccount}
        <span className="block font-mono text-xs text-ink-3">{entry.debitCode.slice(0, 15)}</span>
      </span>
    ),
  },
  {
    header: "Credit",
    cell: (entry) => (
      <span>
        {entry.creditAccount}
        <span className="block font-mono text-xs text-ink-3">{entry.creditCode.slice(0, 15)}</span>
      </span>
    ),
  },
  { header: "Amount", align: "right", cell: (entry) => <Money value={entry.amount} /> },
  { header: "Transaction", cell: (entry) => <TxHash hash={entry.txHash} /> },
];

const RUN_COLUMNS: Column<ReconciliationRun>[] = [
  { header: "Block", cell: (run) => <span className="figures">{run.blockNumber}</span> },
  { header: "Run", cell: (run) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(run.runAt)}</span> },
  { header: "Supply on chain", align: "right", cell: (run) => <Money value={run.totalSupply} /> },
  { header: "Ledger liabilities", align: "right", cell: (run) => <Money value={run.ledgerLiabilities} /> },
  { header: "Reserve statement", align: "right", cell: (run) => <Money value={run.reportedReserve} muted /> },
  { header: "Wallets", align: "right", cell: (run) => run.walletsChecked },
  {
    header: "Result",
    cell: (run) => (
      <span>
        <StatusBadge status={run.status} />
        {run.mismatches.length > 0 && (
          <span className="block text-xs text-critical">{run.mismatches.length} wallets differ</span>
        )}
      </span>
    ),
  },
  { header: "By", cell: (run) => <span className="text-xs text-ink-2">{run.triggeredBy}</span> },
];

export function LedgerPage() {
  const trialBalance = useApi<TrialBalance>("/v1/ledger/trial-balance");
  const journal = useApi<JournalEntry[]>("/v1/ledger/journal?limit=60");
  const runs = useApi<ReconciliationRun[]>("/v1/reconciliation");
  const { notify } = useToast();
  const totals = trialBalance.data?.totals;

  const reconcile = async () => {
    try {
      const run = await api.post<ReconciliationRun>("/v1/reconciliation");
      await runs.refetch();
      notify(
        run.status === "Balanced" ? "good" : "critical",
        `Reconciliation at block ${run.blockNumber}: ${run.status}`,
      );
    } catch (error) {
      notify("critical", "Reconciliation failed", describeError(error));
    }
  };

  return (
    <>
      <PageHeader
        title="Ledger"
        description="Every token movement posts a balanced journal entry. The books are reconciled against chain balances and the reserve statement."
        actions={
          <RoleGate roles={RECONCILERS}>
            <Button variant="primary" onClick={reconcile}>
              Reconcile now
            </Button>
          </RoleGate>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Reserve asset" value={compactTaka(totals?.assets ?? "0")} hint="Account 1000, taka in trust" />
        <Stat
          label="Wallet liabilities"
          value={compactTaka(totals?.liabilities ?? "0")}
          hint="Accounts 2000, tBDT owed to holders"
        />
        <Stat
          label="Debits and credits"
          value={totals && totals.totalDebits === totals.totalCredits ? "In balance" : "Out of balance"}
          hint={totals ? <Money value={totals.totalDebits} muted /> : undefined}
        />
        <Stat label="Journal entries" value={totals?.entries ?? "-"} hint="One per token movement" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card
          className="xl:col-span-2"
          title="Liabilities by institution"
          subtitle="Balances owed to wallet holders, by sponsor and tier."
          flush
        >
          <div className="max-h-96 overflow-y-auto">
            <DataTable
              rowKey={(row) => `${row.institutionId}-${row.tier}`}
              rows={trialBalance.data?.liabilities}
              columns={[
                { header: "Institution", cell: (row) => row.institutionName },
                { header: "Tier", cell: (row) => <Tag>{row.tier}</Tag> },
                { header: "Wallets", align: "right", cell: (row) => row.wallets },
                { header: "Balance", align: "right", cell: (row) => <Money value={row.balance} /> },
              ]}
            />
          </div>
        </Card>
        <Card
          className="xl:col-span-3"
          title="Reconciliation runs"
          subtitle="Ledger, chain and reserve compared at one block."
          flush
        >
          <div className="max-h-96 overflow-y-auto">
            <DataTable
              rowKey={(run) => run.id}
              rows={runs.data}
              columns={RUN_COLUMNS}
              empty="No reconciliation has run yet."
            />
          </div>
        </Card>
      </div>

      <Card
        className="mt-4"
        title="Journal"
        subtitle="Most recent entries. Each debits one account and credits another for the same amount."
        flush
      >
        <DataTable rowKey={(entry) => entry.id} rows={journal.data} columns={JOURNAL_COLUMNS} />
      </Card>
    </>
  );
}
