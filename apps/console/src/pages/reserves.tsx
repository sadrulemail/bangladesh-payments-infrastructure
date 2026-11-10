import { useState } from "react";

import { ChartCard, CoverageChart } from "../components/charts";
import {
  Button,
  Card,
  type Column,
  DataTable,
  Dialog,
  Field,
  Input,
  Money,
  PageHeader,
  RoleGate,
  Select,
  Stat,
  StatusBadge,
  TxHash,
} from "../components/ui";
import { compactTaka, formatBusinessDay, formatDateTime, formatTaka, percentage, toTakaNumber } from "../lib/format";
import { useApi, useCommand } from "../lib/hooks";
import { hasRole, useOperator } from "../lib/session";
import type { Coverage, Institution, Reserves } from "../lib/types";

type Issuance = Reserves["issuance"][number];
type Redemption = Reserves["redemptions"][number];

const REDEEMERS = ["institution_admin", "exchange_house", "treasury"] as const;

/** Institution with the bank reference of its request underneath. */
function Reference({ name, code }: { name: string; code: string }) {
  return (
    <span className="block">
      <span className="block truncate font-medium">{name}</span>
      <span className="block font-mono text-xs whitespace-nowrap text-ink-3">{code}</span>
    </span>
  );
}

function StatementDialog({ onClose }: { onClose: () => void }) {
  const command = useCommand(onClose);
  const [balance, setBalance] = useState("");
  const [document, setDocument] = useState(`Teesta trust account statement ${new Date().toISOString().slice(0, 10)}`);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Publish a reserve statement"
      description="The balance of the trust account caps the supply. Issuance stops when the statement is older than two days."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!balance || document.length < 3 || command.isPending}
            onClick={() =>
              command.mutate({
                path: "/v1/reserves/statements",
                done: "Reserve statement published",
                body: { balance, document },
              })
            }
          >
            Publish
          </Button>
        </>
      }
    >
      <Field label="Balance of the trust account, in taka">
        <Input
          inputMode="decimal"
          placeholder="0.00"
          value={balance}
          onChange={(event) => setBalance(event.target.value)}
        />
      </Field>
      <Field label="Statement document" hint="The hash of this reference is recorded on chain.">
        <Input value={document} onChange={(event) => setDocument(event.target.value)} />
      </Field>
    </Dialog>
  );
}

function IssuanceDialog({ onClose }: { onClose: () => void }) {
  const institutions = useApi<Institution[]>("/v1/institutions");
  const command = useCommand(onClose);
  const [institution, setInstitution] = useState("");
  const [amount, setAmount] = useState("");
  const [fundingRef, setFundingRef] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record an issuance"
      description="Enter the bank transfer received in the trust account. A second officer approves before anything is minted."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!institution || !amount || !fundingRef || command.isPending}
            onClick={() =>
              command.mutate({
                path: "/v1/reserves/issuance",
                done: "Issuance requested, awaiting the checker",
                body: { institution, amount, fundingRef },
              })
            }
          >
            Request
          </Button>
        </>
      }
    >
      <Field label="Institution">
        <Select value={institution} onChange={(event) => setInstitution(event.target.value)}>
          <option value="">Select an institution</option>
          {(institutions.data ?? [])
            .filter((item) => item.active && item.kind !== "NetworkOperator")
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="Amount in taka">
        <Input
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </Field>
      <Field label="Bank transfer reference" hint="Each reference funds one issuance.">
        <Input
          value={fundingRef}
          onChange={(event) => setFundingRef(event.target.value)}
          maxLength={31}
          placeholder="RTGS-..."
        />
      </Field>
    </Dialog>
  );
}

function RedemptionDialog({ onClose }: { onClose: () => void }) {
  const command = useCommand(onClose);
  const [amount, setAmount] = useState("");
  const [payoutRef, setPayoutRef] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title="Redeem tBDT"
      description="The amount leaves your settlement account and is held by the controller until the taka payout is confirmed."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!amount || !payoutRef || command.isPending}
            onClick={() =>
              command.mutate({
                path: "/v1/reserves/redemptions",
                done: "Redemption requested",
                body: { amount, payoutRef },
              })
            }
          >
            Redeem
          </Button>
        </>
      }
    >
      <Field label="Amount in taka">
        <Input
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </Field>
      <Field label="Payout reference">
        <Input
          value={payoutRef}
          onChange={(event) => setPayoutRef(event.target.value)}
          maxLength={31}
          placeholder="BEFTN-..."
        />
      </Field>
    </Dialog>
  );
}

export function ReservesPage() {
  const operator = useOperator();
  const reserves = useApi<Reserves>("/v1/reserves");
  const coverage = useApi<Coverage>("/v1/reserves/coverage");
  const command = useCommand();
  const [dialog, setDialog] = useState<"statement" | "issuance" | "redemption" | null>(null);
  const isChecker = hasRole(operator, ["reserve_checker"]);

  const statement = reserves.data?.statements[0];
  const supply = reserves.data?.totalSupply ?? "0";
  const reserve = statement?.balance ?? "0";
  const headroom = BigInt(reserve) - BigInt(supply);

  /** Buttons of the checker on a pending request. */
  const decide = (kind: "issuance" | "redemptions", id: string, approve: string, approved: string) => (
    <span className="flex justify-end gap-1.5">
      <Button
        small
        variant="primary"
        disabled={command.isPending}
        onClick={() => command.mutate({ path: `/v1/reserves/${kind}/${id}/${approve}`, done: approved })}
      >
        {approve === "approve" ? "Approve" : "Confirm payout"}
      </Button>
      <Button
        small
        variant="danger"
        disabled={command.isPending}
        onClick={() => {
          const reason = window.prompt("Reason code for the rejection");
          if (reason)
            command.mutate({ path: `/v1/reserves/${kind}/${id}/reject`, done: "Request rejected", body: { reason } });
        }}
      >
        Reject
      </Button>
    </span>
  );

  const issuanceColumns: Column<Issuance>[] = [
    {
      header: "Requested",
      cell: (item) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(item.requestedAt)}</span>,
    },
    {
      header: "Institution and bank transfer",
      cell: (item) => <Reference name={item.institutionName} code={item.fundingRef} />,
    },
    { header: "Amount", align: "right", cell: (item) => <Money value={item.amount} /> },
    {
      header: "Status",
      cell: (item) => (
        <span>
          <StatusBadge status={item.status} />
          {item.reason && <span className="block text-xs text-ink-3">{item.reason}</span>}
        </span>
      ),
    },
    {
      header: "",
      align: "right",
      cell: (item) =>
        item.status === "Pending" && isChecker
          ? decide("issuance", item.id, "approve", "Issuance approved and minted")
          : null,
    },
  ];

  const redemptionColumns: Column<Redemption>[] = [
    {
      header: "Requested",
      cell: (item) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(item.requestedAt)}</span>,
    },
    {
      header: "Institution and payout",
      cell: (item) => <Reference name={item.institutionName} code={item.payoutRef} />,
    },
    { header: "Amount", align: "right", cell: (item) => <Money value={item.amount} /> },
    {
      header: "Status",
      cell: (item) => (
        <span>
          <StatusBadge status={item.status} />
          {item.reason && <span className="block text-xs text-ink-3">{item.reason}</span>}
        </span>
      ),
    },
    {
      header: "",
      align: "right",
      cell: (item) =>
        item.status === "Pending" && isChecker
          ? decide("redemptions", item.id, "settle", "Redemption settled and burned")
          : null,
    },
  ];

  const days = coverage.data?.days ?? [];

  return (
    <>
      <PageHeader
        title="Reserves"
        description="Every tBDT is backed by taka in the reserve trust account. Issuance is maker-checker and can never exceed the most recent reserve statement."
        actions={
          <>
            {hasRole(operator, ["reserve_auditor"]) && (
              <Button onClick={() => setDialog("statement")}>Publish statement</Button>
            )}
            {hasRole(operator, REDEEMERS) && <Button onClick={() => setDialog("redemption")}>Redeem tBDT</Button>}
            <RoleGate roles={["issuance_maker"]}>
              <Button variant="primary" onClick={() => setDialog("issuance")}>
                Record an issuance
              </Button>
            </RoleGate>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="tBDT in circulation" value={compactTaka(supply)} hint={<Money value={supply} muted />} />
        <Stat
          label="Reserve statement"
          value={compactTaka(reserve)}
          hint={`As of ${formatDateTime(statement?.asOf)}`}
        />
        <Stat label="Reserve cover" value={percentage(reserve, supply)} hint="Reserve as a share of supply" />
        <Stat label="Headroom for issuance" value={compactTaka(headroom)} hint="Reserve not yet issued against" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Supply against the reserve"
          subtitle="End of each business day in Dhaka. Supply stays at or below the statement in force."
          table={
            <DataTable
              rowKey={(day) => day.businessDate}
              rows={days}
              columns={[
                { header: "Business day", cell: (day) => formatBusinessDay(day.businessDate) },
                { header: "tBDT in circulation", align: "right", cell: (day) => <Money value={day.supply} /> },
                { header: "Reserve statement", align: "right", cell: (day) => <Money value={day.reserve} /> },
              ]}
            />
          }
        >
          <CoverageChart
            points={days.map((day) => ({
              label: formatBusinessDay(day.businessDate),
              supply: toTakaNumber(day.supply),
              reserve: day.reserve === null ? null : toTakaNumber(day.reserve),
            }))}
          />
        </ChartCard>

        <Card title="Reserve statements" subtitle="Published by the reserve auditor." flush>
          <div className="max-h-72 overflow-y-auto">
            <DataTable
              rowKey={(item) => item.idx}
              rows={reserves.data?.statements}
              columns={[
                {
                  header: "As of",
                  cell: (item) => <span className="whitespace-nowrap">{formatDateTime(item.asOf)}</span>,
                },
                { header: "Balance", align: "right", cell: (item) => <Money value={item.balance} /> },
                { header: "Transaction", cell: (item) => <TxHash hash={item.txHash} /> },
              ]}
            />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 2xl:grid-cols-2">
        <Card
          title="Issuance requests"
          subtitle={`Recorded by the maker, approved by the checker. Headroom ${formatTaka(headroom)}.`}
          flush
        >
          <div className="max-h-96 overflow-y-auto">
            <DataTable rowKey={(item) => item.id} rows={reserves.data?.issuance} columns={issuanceColumns} />
          </div>
        </Card>
        <Card
          title="Redemption requests"
          subtitle="tBDT held by the controller until the taka payout is confirmed."
          flush
        >
          <div className="max-h-96 overflow-y-auto">
            <DataTable rowKey={(item) => item.id} rows={reserves.data?.redemptions} columns={redemptionColumns} />
          </div>
        </Card>
      </div>

      {dialog === "statement" && <StatementDialog onClose={() => setDialog(null)} />}
      {dialog === "issuance" && <IssuanceDialog onClose={() => setDialog(null)} />}
      {dialog === "redemption" && <RedemptionDialog onClose={() => setDialog(null)} />}
    </>
  );
}
