import { PURPOSE_CODES } from "@takarail/sdk/domain";
import { useState } from "react";

import { RankedBars } from "../components/charts";
import {
  Button,
  Card,
  type Column,
  DataTable,
  Dialog,
  Facts,
  Field,
  Input,
  Money,
  PageHeader,
  Party,
  RoleGate,
  Segmented,
  Select,
  StatusBadge,
  Tag,
  TxHash,
} from "../components/ui";
import {
  compactTaka,
  formatBps,
  formatDateTime,
  formatForeign,
  formatRate,
  formatTaka,
  purposeLabel,
} from "../lib/format";
import { useApi, useCommand } from "../lib/hooks";
import { hasRole, useOperator } from "../lib/session";
import type { Account, Corridor, DistrictRow, Policy, Quote, Remittance } from "../lib/types";

const AMOUNT = /^\d+(\.\d{1,2})?$/;

const FILTERS = [
  { value: "all", label: "All" },
  { value: "UnderReview", label: "Under review" },
] as const;

function PublishRateDialog({ corridor, onClose }: { corridor: Corridor; onClose: () => void }) {
  const command = useCommand(onClose);
  const [rate, setRate] = useState(corridor.referenceRate ? formatRate(corridor.referenceRate) : "");
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reference rate for ${corridor.id}`}
      description={`Taka per ${corridor.currency}. Exchange houses must quote within the band around this rate.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!rate || command.isPending}
            onClick={() =>
              command.mutate({
                path: `/v1/corridors/${corridor.id}/rate`,
                done: "Reference rate published",
                body: { rate },
              })
            }
          >
            Publish
          </Button>
        </>
      }
    >
      <Field label={`BDT per ${corridor.currency}`}>
        <Input inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} />
      </Field>
    </Dialog>
  );
}

function SendRemittanceDialog({ corridors, onClose }: { corridors: Corridor[]; onClose: () => void }) {
  const accounts = useApi<Account[]>("/v1/accounts?limit=200");
  const command = useCommand(onClose);
  const [corridorId, setCorridorId] = useState(corridors[0]?.id ?? "");
  const [beneficiary, setBeneficiary] = useState("");
  const [sourceAmount, setSourceAmount] = useState("");
  const [purpose, setPurpose] = useState("FAMI");
  const [senderRef, setSenderRef] = useState(`REM-${Date.now().toString().slice(-10)}`);

  const corridor = corridors.find((item) => item.id === corridorId);
  const validAmount = AMOUNT.exec(sourceAmount) !== null && Number(sourceAmount) > 0;
  const quote = useApi<Quote>(`/v1/remittances/quote?corridor=${corridorId}&sourceAmount=${sourceAmount}`, {
    enabled: validAmount && corridorId !== "",
  });
  const beneficiaries = (accounts.data ?? []).filter((account) => account.tier === "Basic" || account.tier === "Full");

  return (
    <Dialog
      open
      onClose={onClose}
      title="Send a remittance"
      description="The payout leaves the exchange house's settlement account and reaches the beneficiary's wallet with the incentive."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!beneficiary || !validAmount || !senderRef || command.isPending}
            onClick={() =>
              command.mutate({
                path: "/v1/remittances",
                done: "Remittance accepted by the gateway",
                body: { corridor: corridorId, beneficiary, sourceAmount, purpose, senderRef },
              })
            }
          >
            {command.isPending ? "Sending…" : "Send"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Corridor">
          <Select value={corridorId} onChange={(event) => setCorridorId(event.target.value)}>
            {corridors.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} ({item.currency})
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Amount in ${corridor?.currency ?? "source currency"}`}>
          <Input
            inputMode="decimal"
            placeholder="0.00"
            value={sourceAmount}
            onChange={(event) => setSourceAmount(event.target.value)}
          />
        </Field>
      </div>
      <Field label="Beneficiary">
        <Select value={beneficiary} onChange={(event) => setBeneficiary(event.target.value)}>
          <option value="">Select a beneficiary</option>
          {beneficiaries.map((account) => (
            <option key={account.address} value={account.address}>
              {account.label ?? account.address} &middot; {account.district ?? "-"} &middot; {account.institutionName}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Purpose">
          <Select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
            {Object.entries(PURPOSE_CODES).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Your reference" hint="Accepted once.">
          <Input value={senderRef} onChange={(event) => setSenderRef(event.target.value)} maxLength={31} />
        </Field>
      </div>
      {quote.data && validAmount && (
        <div className="rounded-lg bg-brand-wash px-4 py-3">
          <Facts
            items={[
              ["Reference rate", `${formatRate(quote.data.rate)} BDT per ${quote.data.currency}`],
              ["Beneficiary receives", <Money key="amount" value={quote.data.amount} />],
              ["Cash incentive", <Money key="incentive" value={quote.data.incentive} />],
              [
                "Total credited",
                <strong key="total">{formatTaka(BigInt(quote.data.amount) + BigInt(quote.data.incentive))}</strong>,
              ],
            ]}
          />
        </div>
      )}
    </Dialog>
  );
}

function RejectDialog({ remittance, onClose }: { remittance: Remittance; onClose: () => void }) {
  const command = useCommand(onClose);
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reject remittance ${remittance.id}`}
      description={`${formatTaka(remittance.amount)} returns to ${remittance.originatorName}.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={!reason || command.isPending}
            onClick={() =>
              command.mutate({
                path: `/v1/remittances/${remittance.id}/reject`,
                done: "Remittance rejected",
                body: { reason },
              })
            }
          >
            Reject
          </Button>
        </>
      }
    >
      <Field label="Reason code" hint="Recorded on chain with the decision, for instance DOCS-NOT-PROVIDED.">
        <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={31} />
      </Field>
    </Dialog>
  );
}

function FundPoolDialog({ onClose }: { onClose: () => void }) {
  const command = useCommand(onClose);
  const [amount, setAmount] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title="Fund the incentive pool"
      description="The amount moves from the Treasury account to the gateway and pays the cash incentive on remittances."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!amount || command.isPending}
            onClick={() =>
              command.mutate({
                path: "/v1/remittances/incentive-pool",
                done: "Incentive pool funded",
                body: { amount },
              })
            }
          >
            Fund
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
    </Dialog>
  );
}

export function RemittancesPage() {
  const operator = useOperator();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all");
  const [rateFor, setRateFor] = useState<Corridor | null>(null);
  const [rejecting, setRejecting] = useState<Remittance | null>(null);
  const [dialog, setDialog] = useState<"send" | "pool" | null>(null);
  const corridors = useApi<Corridor[]>("/v1/corridors");
  const remittances = useApi<Remittance[]>(`/v1/remittances?limit=100${filter === "all" ? "" : `&status=${filter}`}`);
  const policy = useApi<Policy>("/v1/policy");
  const districts = useApi<DistrictRow[]>("/v1/reports/beneficiary-districts");
  const command = useCommand();

  const ownCorridors = (corridors.data ?? []).filter(
    (corridor) =>
      corridor.active && corridor.originators.some((originator) => originator.id === operator.institutionId),
  );
  const isCompliance = hasRole(operator, ["compliance_officer"]);
  const gateway = policy.data?.gateway;

  const columns: Column<Remittance>[] = [
    {
      header: "Received",
      cell: (item) => (
        <span className="whitespace-nowrap text-ink-2">
          {formatDateTime(item.createdAt)}
          <span className="block">
            <TxHash hash={item.txHash} />
          </span>
        </span>
      ),
    },
    {
      header: "Corridor",
      cell: (item) => (
        <span className="whitespace-nowrap">
          <Tag>{item.corridorId}</Tag>
          <span className="mt-0.5 block text-xs text-ink-3">{item.originatorName}</span>
        </span>
      ),
    },
    {
      header: "Beneficiary",
      cell: (item) => (
        <Party
          label={item.beneficiaryLabel}
          address={item.beneficiary}
          note={[item.beneficiaryDistrict, item.beneficiaryInstitution].filter(Boolean).join(", ")}
        />
      ),
    },
    {
      header: "Sent",
      align: "right",
      cell: (item) => (
        <span className="whitespace-nowrap">
          {formatForeign(item.sourceAmount, item.currency)}
          <span className="block text-xs text-ink-3">at {formatRate(item.rate)}</span>
        </span>
      ),
    },
    {
      header: "Payout and incentive",
      align: "right",
      cell: (item) => (
        <span className="whitespace-nowrap">
          <Money value={item.amount} />
          {item.status === "Paid" && (
            <span className="block text-xs text-ink-3">
              + {formatTaka(item.incentive)}
              {item.incentivePaid ? "" : " deferred"}
            </span>
          )}
        </span>
      ),
    },
    {
      header: "Status",
      cell: (item) => (
        <span>
          <StatusBadge status={item.status} />
          <span className="mt-0.5 block text-xs text-ink-3">{item.reason ?? purposeLabel(item.purpose)}</span>
        </span>
      ),
    },
    {
      header: "",
      align: "right",
      cell: (item) => {
        if (item.status !== "UnderReview") return null;
        if (isCompliance) {
          return (
            <span className="flex justify-end gap-1.5">
              <Button
                small
                variant="primary"
                disabled={command.isPending}
                onClick={() =>
                  command.mutate({
                    path: `/v1/remittances/${item.id}/release`,
                    done: "Remittance released to the beneficiary",
                  })
                }
              >
                Release
              </Button>
              <Button small variant="danger" onClick={() => setRejecting(item)}>
                Reject
              </Button>
            </span>
          );
        }
        if (item.originatorId === operator.institutionId) {
          return (
            <Button
              small
              disabled={command.isPending}
              onClick={() =>
                command.mutate({ path: `/v1/remittances/${item.id}/reclaim`, done: "Remittance reclaimed" })
              }
            >
              Reclaim
            </Button>
          );
        }
        return null;
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Remittances"
        description="Inward remittance corridors. Small amounts pay out straight through; amounts above the screening threshold wait for compliance."
        actions={
          <>
            {hasRole(operator, ["treasury"]) && <Button onClick={() => setDialog("pool")}>Fund incentive pool</Button>}
            <RoleGate roles={["exchange_house"]}>
              <Button variant="primary" disabled={ownCorridors.length === 0} onClick={() => setDialog("send")}>
                Send a remittance
              </Button>
            </RoleGate>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {(corridors.data ?? []).map((corridor) => (
          <Card key={corridor.id}>
            <div className="flex items-start justify-between pt-4">
              <div>
                <div className="text-sm font-semibold">{corridor.id}</div>
                <div className="text-xs text-ink-3">
                  {corridor.originators.map((originator) => originator.name).join(", ")}
                </div>
              </div>
              <StatusBadge status={corridor.active ? "Active" : "Suspended"} />
            </div>
            <div className="mt-3 text-2xl font-semibold tracking-tight">
              {corridor.referenceRate ? formatRate(corridor.referenceRate) : "-"}
              <span className="ml-1.5 text-xs font-normal text-ink-3">BDT per {corridor.currency}</span>
            </div>
            <div className="mt-1 text-xs text-ink-3">Published {formatDateTime(corridor.rateUpdatedAt)}</div>
            <div className="mt-3 flex items-center justify-between text-xs text-ink-2">
              <span>
                {corridor.paidCount} paid &middot; {compactTaka(corridor.paidAmount)}
              </span>
              {hasRole(operator, ["issuance_maker"]) && (
                <Button small onClick={() => setRateFor(corridor)}>
                  Publish rate
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      <Card
        className="mt-4"
        title="Remittances"
        subtitle="Most recent first."
        flush
        actions={<Segmented label="Remittance filter" value={filter} options={FILTERS} onChange={setFilter} />}
      >
        <DataTable
          rowKey={(item) => item.id}
          rows={remittances.data}
          columns={columns}
          empty="No remittance matches this filter."
        />
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Gateway policy" subtitle="Enforced by the contract on every remittance.">
          {gateway && (
            <Facts
              items={[
                ["Cash incentive", formatBps(gateway.incentiveBps)],
                ["Incentive pool", <Money key="pool" value={gateway.incentivePool} />],
                ["Rate band", `±${formatBps(gateway.rateBandBps)}`],
                ["Rate valid for", `${gateway.rateValidity / 3600} h`],
                ["Screening threshold", <Money key="threshold" value={gateway.screeningThreshold} />],
                ["Review window", `${gateway.reviewWindow / 3600} h`],
              ]}
            />
          )}
        </Card>
        <Card title="Where remittances arrive" subtitle="Taka paid, by district of the beneficiary.">
          <RankedBars
            rows={(districts.data ?? []).slice(0, 7).map((row) => ({
              key: row.district,
              label: row.district,
              note: `${row.remittances}`,
              amount: row.amount,
            }))}
          />
        </Card>
      </div>

      {rateFor && <PublishRateDialog corridor={rateFor} onClose={() => setRateFor(null)} />}
      {rejecting && <RejectDialog remittance={rejecting} onClose={() => setRejecting(null)} />}
      {dialog === "send" && <SendRemittanceDialog corridors={ownCorridors} onClose={() => setDialog(null)} />}
      {dialog === "pool" && <FundPoolDialog onClose={() => setDialog(null)} />}
    </>
  );
}
