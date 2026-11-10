import { useState } from "react";

import { NetBar } from "../components/charts";
import {
  Button,
  Card,
  type Column,
  DataTable,
  Money,
  PageHeader,
  Select,
  StatusBadge,
  Tag,
  TxHash,
} from "../components/ui";
import { describeError, download } from "../lib/api";
import { formatBusinessDay, formatDateTime, formatTaka, humanise } from "../lib/format";
import { useApi } from "../lib/hooks";
import { hasRole, useOperator } from "../lib/session";
import { useToast } from "../lib/toast";
import type { AuditEntry, SettlementReport } from "../lib/types";

type Position = SettlementReport["positions"][number];
type Flow = SettlementReport["flows"][number];

const AUDITORS = ["supervisor", "network_operator", "reserve_auditor"] as const;

const AUDIT_COLUMNS: Column<AuditEntry>[] = [
  {
    header: "Submitted",
    cell: (entry) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(entry.createdAt)}</span>,
  },
  { header: "Operator", cell: (entry) => entry.displayName ?? entry.operator },
  { header: "Command", cell: (entry) => <span className="font-mono text-xs">{entry.action}</span> },
  {
    header: "Outcome",
    cell: (entry) => (
      <span>
        <StatusBadge status={entry.outcome} />
        {entry.error && <span className="block text-xs text-critical">{entry.error}</span>}
      </span>
    ),
  },
  { header: "Transaction", cell: (entry) => <TxHash hash={entry.txHash} /> },
];

export function ReportsPage() {
  const operator = useOperator();
  const { notify } = useToast();
  const [date, setDate] = useState("");
  const report = useApi<SettlementReport>(`/v1/reports/settlement-positions${date ? `?date=${date}` : ""}`);
  const mayAudit = hasRole(operator, AUDITORS);
  const audit = useApi<AuditEntry[]>("/v1/audit-log", { enabled: mayAudit });

  const positions = report.data?.positions ?? [];
  const largest = positions.reduce((max, position) => {
    const net = BigInt(position.netPosition);
    const magnitude = net < 0n ? -net : net;
    return magnitude > max ? magnitude : max;
  }, 0n);

  const save = async (path: string, fileName: string) => {
    try {
      await download(path, fileName);
    } catch (error) {
      notify("critical", "Download failed", describeError(error));
    }
  };

  const positionColumns: Column<Position>[] = [
    {
      header: "Institution",
      cell: (position) => (
        <span>
          <span className="font-medium">{position.institutionName}</span>
          <span className="block text-xs text-ink-3">{humanise(position.kind)}</span>
        </span>
      ),
    },
    { header: "Received", align: "right", cell: (position) => <Money value={position.inflow} /> },
    { header: "Paid", align: "right", cell: (position) => <Money value={position.outflow} /> },
    {
      header: "Net position",
      align: "right",
      cell: (position) => {
        const net = BigInt(position.netPosition);
        return (
          <span className="figures whitespace-nowrap font-medium">
            {net > 0n ? "+" : ""}
            {formatTaka(net)}
          </span>
        );
      },
    },
    {
      header: "Paid out / received",
      cell: (position) => <NetBar value={BigInt(position.netPosition)} max={largest} />,
    },
  ];

  const flowColumns: Column<Flow>[] = [
    { header: "From", cell: (flow) => <Tag>{flow.fromInstitution}</Tag> },
    { header: "To", cell: (flow) => <Tag>{flow.toInstitution}</Tag> },
    { header: "Rail", cell: (flow) => humanise(flow.flowType) },
    { header: "Movements", align: "right", cell: (flow) => flow.movements },
    { header: "Amount", align: "right", cell: (flow) => <Money value={flow.amount} /> },
  ];

  return (
    <>
      <PageHeader
        title="Reports"
        description="Settlement positions between institutions, remittance inflows and the trail of every command an operator submitted."
        actions={
          <>
            <Button onClick={() => save("/v1/reports/remittances?format=csv", "inward-remittances.csv")}>
              Remittances (CSV)
            </Button>
            <Button
              onClick={() =>
                save(
                  `/v1/reports/settlement-positions?format=csv${date ? `&date=${date}` : ""}`,
                  `settlement-positions-${report.data?.date ?? "today"}.csv`,
                )
              }
            >
              Positions (CSV)
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-5">
        <Card
          className="xl:col-span-3"
          title="Settlement positions"
          subtitle="Value received from and paid to the rest of the network. Positions sum to zero: settlement is final on chain."
          flush
          actions={
            <Select
              className="w-40"
              aria-label="Business day"
              value={date || report.data?.date || ""}
              onChange={(event) => setDate(event.target.value)}
            >
              {(report.data?.dates ?? []).map((item) => (
                <option key={item} value={item}>
                  {formatBusinessDay(item)}
                </option>
              ))}
            </Select>
          }
        >
          <DataTable
            rowKey={(position) => position.institutionId}
            rows={report.data?.positions}
            columns={positionColumns}
          />
        </Card>
        <Card
          className="xl:col-span-2"
          title="Flows between institutions"
          subtitle="Largest first, for the same business day."
          flush
        >
          <div className="max-h-[32rem] overflow-y-auto">
            <DataTable
              rowKey={(flow) => `${flow.fromInstitution}-${flow.toInstitution}-${flow.flowType}`}
              rows={report.data?.flows}
              columns={flowColumns}
              empty="No value moved between institutions on this day."
            />
          </div>
        </Card>
      </div>

      <Card
        className="mt-4"
        title="Audit trail"
        subtitle="Every command, accepted or refused by the network, with the operator who submitted it."
        flush
      >
        {mayAudit ? (
          <div className="max-h-[28rem] overflow-y-auto">
            <DataTable rowKey={(entry) => entry.id} rows={audit.data} columns={AUDIT_COLUMNS} />
          </div>
        ) : (
          <p className="px-5 pb-5 text-sm text-ink-3">
            The audit trail is open to the supervisor, the network operator and the reserve auditor.
          </p>
        )}
      </Card>
    </>
  );
}
