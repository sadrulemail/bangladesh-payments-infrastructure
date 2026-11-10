import { PURPOSE_CODES } from "@takarail/sdk/domain";
import { useState } from "react";

import {
  Button,
  Card,
  type Column,
  DataTable,
  Dialog,
  Facts,
  Field,
  Input,
  Loading,
  Money,
  PageHeader,
  Party,
  RoleGate,
  Select,
  StatusBadge,
  Tag,
  Textarea,
  TxHash,
} from "../components/ui";
import { formatDateTime, formatTaka, purposeLabel } from "../lib/format";
import { useApi, useCommand } from "../lib/hooks";
import { hasRole, useOperator } from "../lib/session";
import type { Account, Batch, BatchDetail } from "../lib/types";

const ADMIN = ["institution_admin"] as const;

interface ParsedPayouts {
  payouts: { account: string; amount: string }[];
  error: string | null;
}

const WALLET = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^\d+(\.\d{1,2})?$/;

/** Reads "wallet,amount" lines. */
function parsePayouts(text: string): ParsedPayouts {
  const payouts: ParsedPayouts["payouts"] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const [account = "", amount = ""] = line.split(/[,;\t]/).map((part) => part.trim());
    if (!WALLET.exec(account) || !AMOUNT.exec(amount)) {
      return { payouts: [], error: `Line ${index + 1} is not "wallet,amount"` };
    }
    payouts.push({ account, amount });
  }
  return { payouts, error: null };
}

function NewBatchDialog({ onClose }: { onClose: () => void }) {
  const operator = useOperator();
  const own = useApi<Account[]>(`/v1/accounts?institution=${operator.institutionId}&limit=200`);
  const everyone = useApi<Account[]>("/v1/accounts?tier=Basic&limit=200");
  const command = useCommand(onClose);
  const [payer, setPayer] = useState("");
  const [batchRef, setBatchRef] = useState(`BATCH-${new Date().toISOString().slice(0, 10)}`);
  const [purpose, setPurpose] = useState("SALA");
  const [text, setText] = useState("");
  const [defaultAmount, setDefaultAmount] = useState("12500.00");

  const payers = (own.data ?? []).filter((account) => account.tier === "Corporate" && account.inCustody);
  const parsed = parsePayouts(text);
  const total = parsed.payouts.reduce((sum, payout) => sum + Number(payout.amount), 0);

  const fill = () =>
    setText(
      (everyone.data ?? [])
        .filter((account) => account.status === "Active")
        .map((account) => `${account.address},${defaultAmount}`)
        .join("\n"),
    );

  return (
    <Dialog
      wide
      open
      onClose={onClose}
      title="New disbursement batch"
      description="The payer funds the whole batch. Only the Merkle root of the payout list goes on chain; the list stays with the payer's bank."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!payer || !batchRef || parsed.payouts.length === 0 || command.isPending}
            onClick={() =>
              command.mutate({
                path: "/v1/disbursements",
                done: "Batch funded and awaiting approval",
                body: { payer, batchRef, purpose, payouts: parsed.payouts },
              })
            }
          >
            {command.isPending ? "Funding…" : "Fund batch"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-4">
        <Field label="Payer">
          <Select value={payer} onChange={(event) => setPayer(event.target.value)}>
            <option value="">Select a corporate account</option>
            {payers.map((account) => (
              <option key={account.address} value={account.address}>
                {account.label} &middot; {formatTaka(account.balance)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Batch reference">
          <Input value={batchRef} onChange={(event) => setBatchRef(event.target.value)} maxLength={31} />
        </Field>
        <Field label="Purpose">
          <Select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
            {Object.entries(PURPOSE_CODES).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Payout list" hint="One payout per line: wallet,amount in taka.">
        <Textarea
          rows={9}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="0x...,12500.00"
        />
      </Field>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-2">
          <Field label="Amount for each wallet">
            <Input
              className="w-36"
              inputMode="decimal"
              value={defaultAmount}
              onChange={(event) => setDefaultAmount(event.target.value)}
            />
          </Field>
          <Button onClick={fill}>List every basic wallet</Button>
        </div>
        <p className="text-sm">
          {parsed.error ? (
            <span className="text-critical">{parsed.error}</span>
          ) : (
            <span className="text-ink-2">
              {parsed.payouts.length} payouts &middot; total {formatTaka(BigInt(Math.round(total * 100)))}
            </span>
          )}
        </p>
      </div>
    </Dialog>
  );
}

function BatchDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const operator = useOperator();
  const { data: batch } = useApi<BatchDetail>(`/v1/disbursements/${id}`);
  const command = useCommand();
  const [reason, setReason] = useState("");

  if (!batch) {
    return (
      <Dialog wide open onClose={onClose} title={`Batch ${id}`}>
        <Loading />
      </Dialog>
    );
  }

  const mayAct = hasRole(operator, ADMIN) && operator.institutionId === batch.payerInstitutionId;
  const pending = batch.payoutCount - batch.processed;
  const run = (action: string, done: string, body?: unknown) =>
    command.mutate({ path: `/v1/disbursements/${batch.id}/${action}`, done, body });

  return (
    <Dialog
      wide
      open
      onClose={onClose}
      title={`${batch.batchRef}`}
      description={`${batch.payerLabel ?? batch.payer}, sponsored by ${batch.payerInstitutionName}`}
      footer={
        mayAct ? (
          <>
            {batch.status === "AwaitingApproval" && (
              <>
                <Input
                  className="max-w-52"
                  placeholder="Reason code to reject"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={31}
                />
                <Button
                  variant="danger"
                  disabled={!reason || command.isPending}
                  onClick={() => run("reject", "Batch rejected", { reason })}
                >
                  Reject
                </Button>
                <Button variant="primary" disabled={command.isPending} onClick={() => run("approve", "Batch approved")}>
                  Approve
                </Button>
              </>
            )}
            {batch.status === "Approved" && (
              <>
                <Button disabled={command.isPending} onClick={() => run("close", "Batch closed")}>
                  Close batch
                </Button>
                <Button
                  variant="primary"
                  disabled={pending === 0 || command.isPending}
                  onClick={() => run("execute", "Payouts executed")}
                >
                  Execute {pending > 0 ? `${Math.min(pending, 40)} payouts` : "payouts"}
                </Button>
              </>
            )}
            {(batch.status === "Closed" || batch.status === "Rejected") && <Button onClick={onClose}>Done</Button>}
          </>
        ) : (
          <span className="text-xs text-ink-3">Decided by the administrator of {batch.payerInstitutionName}</span>
        )
      }
    >
      <div className="grid gap-6 md:grid-cols-2">
        <Facts
          items={[
            ["Status", <StatusBadge key="status" status={batch.status} />],
            ["Purpose", purposeLabel(batch.purpose)],
            ["Funded", formatDateTime(batch.createdAt)],
            ["Approved", formatDateTime(batch.approvedAt)],
          ]}
        />
        <Facts
          items={[
            ["Total", <Money key="total" value={batch.total} />],
            ["Paid", <Money key="paid" value={batch.paid} />],
            ["Failed", <Money key="failed" value={batch.failed} />],
            ["Returned to payer", <Money key="returned" value={batch.returned} />],
          ]}
        />
      </div>
      <p className="font-mono text-xs break-all text-ink-3">Merkle root {batch.merkleRoot}</p>
      <div className="-mx-5 max-h-80 overflow-y-auto border-t border-line">
        <DataTable
          rowKey={(payout) => payout.idx}
          rows={batch.payouts}
          empty="The payout list of this batch is not held by this service."
          columns={[
            { header: "#", cell: (payout) => <span className="text-ink-3">{payout.idx + 1}</span> },
            {
              header: "Beneficiary",
              cell: (payout) => <Party label={payout.label} address={payout.account} note={payout.institutionId} />,
            },
            { header: "Amount", align: "right", cell: (payout) => <Money value={payout.amount} /> },
            {
              header: "Status",
              cell: (payout) => (
                <span>
                  <StatusBadge status={payout.status} />
                  {payout.status === "Failed" && payout.accountStatus !== "Active" && (
                    <span className="block text-xs text-ink-3">Account {payout.accountStatus?.toLowerCase()}</span>
                  )}
                </span>
              ),
            },
            { header: "Transaction", cell: (payout) => <TxHash hash={payout.txHash} /> },
          ]}
        />
      </div>
    </Dialog>
  );
}

export function DisbursementsPage() {
  const batches = useApi<Batch[]>("/v1/disbursements");
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const columns: Column<Batch>[] = [
    {
      header: "Funded",
      cell: (batch) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(batch.createdAt)}</span>,
    },
    {
      header: "Batch",
      cell: (batch) => (
        <span>
          <span className="font-medium">{batch.batchRef}</span>
          <span className="block text-xs text-ink-3">{purposeLabel(batch.purpose)}</span>
        </span>
      ),
    },
    {
      header: "Payer",
      cell: (batch) => <Party label={batch.payerLabel} address={batch.payer} note={batch.payerInstitutionId} />,
    },
    {
      header: "Payouts",
      align: "right",
      cell: (batch) => (
        <span>
          {batch.processed} / {batch.payoutCount}
        </span>
      ),
    },
    { header: "Total", align: "right", cell: (batch) => <Money value={batch.total} /> },
    { header: "Paid", align: "right", cell: (batch) => <Money value={batch.paid} /> },
    { header: "Failed", align: "right", cell: (batch) => <Money value={batch.failed} muted /> },
    { header: "Status", cell: (batch) => <StatusBadge status={batch.status} /> },
    { header: "", cell: () => <Tag>Open</Tag> },
  ];

  return (
    <>
      <PageHeader
        title="Disbursements"
        description="Wages and allowances paid in bulk. A batch is funded by the payer, approved by its bank, then executed against a Merkle commitment to the payout list."
        actions={
          <RoleGate roles={ADMIN}>
            <Button variant="primary" onClick={() => setCreating(true)}>
              New batch
            </Button>
          </RoleGate>
        }
      />
      <Card title="Batches" subtitle="Select a batch to see its payouts and act on it." flush>
        <DataTable
          rowKey={(batch) => batch.id}
          rows={batches.data}
          columns={columns}
          onRowClick={(batch) => setOpen(batch.id)}
        />
      </Card>

      {open !== null && <BatchDialog id={open} onClose={() => setOpen(null)} />}
      {creating && <NewBatchDialog onClose={() => setCreating(false)} />}
    </>
  );
}
