import { PURPOSE_CODES } from "@takarail/sdk/domain";
import { useState } from "react";

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
  Party,
  RoleGate,
  Segmented,
  Select,
  Tag,
  Textarea,
  TxHash,
} from "../components/ui";
import { api, describeError } from "../lib/api";
import { formatDateTime, formatTaka, purposeLabel } from "../lib/format";
import { useApi, useCommand } from "../lib/hooks";
import { hasRole, useOperator } from "../lib/session";
import type { Account, Merchant, Payment } from "../lib/types";

const ADMIN = ["institution_admin"] as const;
const KINDS = [
  { value: "all", label: "All" },
  { value: "merchant", label: "Merchant" },
  { value: "person", label: "Person" },
] as const;
const ENTRY_MODES = [
  { value: "merchant", label: "Pick a merchant" },
  { value: "qr", label: "Scanned QR code" },
] as const;

const isPerson = (account: Account) => account.tier === "Basic" || account.tier === "Full";
const optionLabel = (account: Account) =>
  `${account.label ?? account.address} · ${account.institutionId} · ${formatTaka(account.balance)}`;

/** Personal wallets the operator's institution holds in custody. */
function useOwnCustomers() {
  const operator = useOperator();
  const accounts = useApi<Account[]>(`/v1/accounts?institution=${operator.institutionId}&limit=200`, {
    enabled: operator.institutionId !== null && hasRole(operator, ADMIN),
  });
  return (accounts.data ?? []).filter(
    (account) => isPerson(account) && account.inCustody && account.status === "Active",
  );
}

interface DecodedQr {
  merchantId: string;
  merchantName: string;
  merchantCity: string;
  amount?: string;
  invoiceRef?: string;
  registered: boolean;
}

function PayMerchantDialog({ onClose }: { onClose: () => void }) {
  const customers = useOwnCustomers();
  const merchants = useApi<Merchant[]>("/v1/merchants");
  const command = useCommand(onClose);
  const [mode, setMode] = useState<(typeof ENTRY_MODES)[number]["value"]>("merchant");
  const [payer, setPayer] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [amount, setAmount] = useState("");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [qrPayload, setQrPayload] = useState("");
  const [decoded, setDecoded] = useState<DecodedQr | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  const readQr = async () => {
    setQrError(null);
    setDecoded(null);
    try {
      setDecoded(await api.post<DecodedQr>("/v1/qr/decode", { payload: qrPayload }));
    } catch (error) {
      setQrError(describeError(error));
    }
  };

  const needsAmount = mode === "merchant" || decoded?.amount === undefined;
  const ready =
    payer !== "" &&
    (mode === "merchant" ? merchantId !== "" : decoded?.registered === true) &&
    (!needsAmount || amount !== "");

  const submit = () =>
    command.mutate({
      path: "/v1/payments/merchant",
      done: "Merchant payment settled",
      body:
        mode === "merchant"
          ? { payer, merchantId, amount, invoiceRef: invoiceRef || undefined }
          : { payer, qrPayload, amount: needsAmount ? amount : undefined },
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Pay a merchant"
      description="The customer's wallet funds the payment switch, which pays the merchant and splits the fee in the same transaction."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready || command.isPending} onClick={submit}>
            {command.isPending ? "Settling…" : "Pay"}
          </Button>
        </>
      }
    >
      <Field label="Customer wallet">
        <Select value={payer} onChange={(event) => setPayer(event.target.value)}>
          <option value="">Select a customer</option>
          {customers.map((account) => (
            <option key={account.address} value={account.address}>
              {optionLabel(account)}
            </option>
          ))}
        </Select>
      </Field>
      <Segmented label="How the merchant is identified" value={mode} options={ENTRY_MODES} onChange={setMode} />

      {mode === "merchant" ? (
        <>
          <Field label="Merchant">
            <Select value={merchantId} onChange={(event) => setMerchantId(event.target.value)}>
              <option value="">Select a merchant</option>
              {(merchants.data ?? []).map((merchant) => (
                <option key={merchant.id} value={merchant.id}>
                  {merchant.name}, {merchant.city} ({merchant.id})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Invoice number" hint="Optional. A payment that carries an invoice number settles only once.">
            <Input value={invoiceRef} onChange={(event) => setInvoiceRef(event.target.value)} maxLength={25} />
          </Field>
        </>
      ) : (
        <>
          <Field label="QR payload" hint="Paste the text of a Bangla QR code. Generate one under Directory, Merchants.">
            <Textarea rows={4} value={qrPayload} onChange={(event) => setQrPayload(event.target.value)} />
          </Field>
          <Button small onClick={readQr} disabled={qrPayload.trim().length < 20}>
            Read code
          </Button>
          {qrError && <p className="text-sm text-critical">{qrError}</p>}
          {decoded && (
            <p className="rounded-lg bg-sunken px-3 py-2 text-sm">
              <span className="font-medium">{decoded.merchantName}</span>, {decoded.merchantCity} ({decoded.merchantId})
              {decoded.amount && <> &middot; amount {decoded.amount}</>}
              {decoded.invoiceRef && <> &middot; invoice {decoded.invoiceRef}</>}
              {!decoded.registered && (
                <span className="block text-critical">This merchant is not registered on the network.</span>
              )}
            </p>
          )}
        </>
      )}

      {needsAmount && (
        <Field label="Amount in taka">
          <Input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
      )}
    </Dialog>
  );
}

function TransferDialog({ onClose }: { onClose: () => void }) {
  const customers = useOwnCustomers();
  const everyone = useApi<Account[]>("/v1/accounts?limit=200");
  const command = useCommand(onClose);
  const [payer, setPayer] = useState("");
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState(`E2E-${Date.now().toString().slice(-9)}`);
  const [purpose, setPurpose] = useState("FAMI");
  const payees = (everyone.data ?? []).filter((account) => isPerson(account) && account.address !== payer);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Send a transfer"
      description="A transfer between two people settles at once, whether they bank with the same institution or not."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!payer || !payee || !amount || !reference || command.isPending}
            onClick={() =>
              command.mutate({
                path: "/v1/payments/transfer",
                done: "Transfer settled",
                body: { payer, payee, amount, reference, purpose },
              })
            }
          >
            {command.isPending ? "Settling…" : "Send"}
          </Button>
        </>
      }
    >
      <Field label="From">
        <Select value={payer} onChange={(event) => setPayer(event.target.value)}>
          <option value="">Select a customer</option>
          {customers.map((account) => (
            <option key={account.address} value={account.address}>
              {optionLabel(account)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="To">
        <Select value={payee} onChange={(event) => setPayee(event.target.value)}>
          <option value="">Select a beneficiary</option>
          {payees.map((account) => (
            <option key={account.address} value={account.address}>
              {account.label ?? account.address} &middot; {account.institutionName}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount in taka">
          <Input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
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
      <Field label="End-to-end reference">
        <Input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={31} />
      </Field>
    </Dialog>
  );
}

function RefundDialog({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const command = useCommand(onClose);
  const refundable = BigInt(payment.amount) - BigInt(payment.refunded);
  const [amount, setAmount] = useState("");

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Refund payment ${payment.id}`}
      description={`${payment.payeeLabel ?? "The merchant"} returns money to ${payment.payerLabel ?? "the payer"}. Up to ${formatTaka(refundable)} can still be refunded.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!amount || command.isPending}
            onClick={() =>
              command.mutate({ path: `/v1/payments/${payment.id}/refund`, done: "Refund settled", body: { amount } })
            }
          >
            Refund
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

export function PaymentsPage() {
  const operator = useOperator();
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("all");
  const [dialog, setDialog] = useState<"merchant" | "transfer" | null>(null);
  const [refund, setRefund] = useState<Payment | null>(null);
  const payments = useApi<Payment[]>(`/v1/payments?limit=100${kind === "all" ? "" : `&kind=${kind}`}`);
  const mayAct = hasRole(operator, ADMIN);

  const columns: Column<Payment>[] = [
    {
      header: "Settled",
      cell: (payment) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(payment.settledAt)}</span>,
    },
    { header: "Type", cell: (payment) => <Tag>{payment.kind === "merchant" ? "Merchant" : "Person"}</Tag> },
    {
      header: "From",
      cell: (payment) => <Party label={payment.payerLabel} address={payment.payer} note={payment.payerInstitution} />,
    },
    {
      header: "To",
      cell: (payment) => <Party label={payment.payeeLabel} address={payment.payee} note={payment.payeeInstitution} />,
    },
    { header: "Amount", align: "right", cell: (payment) => <Money value={payment.amount} /> },
    {
      header: "Fee",
      align: "right",
      cell: (payment) => <Money value={BigInt(payment.acquirerFee) + BigInt(payment.networkFee)} muted />,
    },
    {
      header: "Reference",
      cell: (payment) => (
        <span className="block max-w-44 truncate text-xs text-ink-2">
          {payment.reference ?? "-"}
          {payment.kind === "person" && <span className="block text-ink-3">{purposeLabel(payment.purpose)}</span>}
          {payment.refunded !== "0" && (
            <span className="block text-critical">Refunded {formatTaka(payment.refunded)}</span>
          )}
        </span>
      ),
    },
    { header: "Transaction", cell: (payment) => <TxHash hash={payment.txHash} /> },
    {
      header: "",
      align: "right",
      cell: (payment) =>
        mayAct &&
        payment.kind === "merchant" &&
        payment.payeeInstitution === operator.institutionId &&
        BigInt(payment.refunded) < BigInt(payment.amount) ? (
          <Button small onClick={() => setRefund(payment)}>
            Refund
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Payments"
        description="Merchant payments and person-to-person transfers settled by the payment switch, across every member institution."
        actions={
          <RoleGate roles={ADMIN}>
            <Button onClick={() => setDialog("transfer")}>Send a transfer</Button>
            <Button variant="primary" onClick={() => setDialog("merchant")}>
              Pay a merchant
            </Button>
          </RoleGate>
        }
      />
      <Card
        title="Settled payments"
        subtitle="Most recent first."
        flush
        actions={<Segmented label="Payment type" value={kind} options={KINDS} onChange={setKind} />}
      >
        <DataTable rowKey={(payment) => payment.id} rows={payments.data} columns={columns} />
      </Card>

      {dialog === "merchant" && <PayMerchantDialog onClose={() => setDialog(null)} />}
      {dialog === "transfer" && <TransferDialog onClose={() => setDialog(null)} />}
      {refund && <RefundDialog payment={refund} onClose={() => setRefund(null)} />}
    </>
  );
}
