import { CUSTOMER_TIERS } from "@takarail/sdk/domain";
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
  Segmented,
  Select,
  StatusBadge,
  Tag,
  TxHash,
} from "../components/ui";
import { api, describeError } from "../lib/api";
import { formatBps, formatDateTime, formatTaka, humanise } from "../lib/format";
import { useApi, useCommand } from "../lib/hooks";
import { hasRole, useOperator } from "../lib/session";
import type { Account, AccountDetail, Institution, Merchant, Policy } from "../lib/types";

const TABS = [
  { value: "institutions", label: "Institutions" },
  { value: "accounts", label: "Accounts" },
  { value: "merchants", label: "Merchants" },
  { value: "policy", label: "Policy" },
] as const;
type Tab = (typeof TABS)[number]["value"];

const unlimited = (value: string) =>
  value === "0" ? <span className="text-ink-3">No limit</span> : <Money value={value} />;

// ------------------------------------------------------------------ accounts

function OpenAccountDialog({ onClose }: { onClose: () => void }) {
  const command = useCommand(onClose);
  const [label, setLabel] = useState("");
  const [district, setDistrict] = useState("");
  const [tier, setTier] = useState<(typeof CUSTOMER_TIERS)[number]>("Basic");
  const [kycReference, setKycReference] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title="Open an account"
      description="A new wallet is created in custody and registered on chain under your institution. Only a hash of the KYC reference leaves your records."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={label.length < 2 || district.length < 2 || !kycReference || command.isPending}
            onClick={() =>
              command.mutate({
                path: "/v1/accounts",
                done: "Account opened",
                body: { label, district, tier, kycReference },
              })
            }
          >
            Open account
          </Button>
        </>
      }
    >
      <Field label="Account holder">
        <Input value={label} onChange={(event) => setLabel(event.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="District">
          <Input value={district} onChange={(event) => setDistrict(event.target.value)} />
        </Field>
        <Field label="Tier">
          <Select value={tier} onChange={(event) => setTier(event.target.value as typeof tier)}>
            {CUSTOMER_TIERS.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="KYC file reference">
        <Input
          value={kycReference}
          onChange={(event) => setKycReference(event.target.value)}
          maxLength={31}
          placeholder="KYC-2026-..."
        />
      </Field>
    </Dialog>
  );
}

function AccountDialog({ address, onClose }: { address: string; onClose: () => void }) {
  const operator = useOperator();
  const { data: account } = useApi<AccountDetail>(`/v1/accounts/${address}`);
  const command = useCommand();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  if (!account) {
    return (
      <Dialog wide open onClose={onClose} title="Account">
        <Loading />
      </Dialog>
    );
  }

  const ownAccount = hasRole(operator, ["institution_admin"]) && operator.institutionId === account.institutionId;
  const mayFreeze = ownAccount || hasRole(operator, ["supervisor"]);
  const isCustomer = account.tier !== "Institution" && account.tier !== "System";
  const base = `/v1/accounts/${account.address}`;

  return (
    <Dialog
      wide
      open
      onClose={onClose}
      title={account.label ?? account.address}
      description={`${account.tier} account at ${account.institutionName}${account.district ? `, ${account.district}` : ""}`}
    >
      <div className="grid gap-6 md:grid-cols-2">
        <Facts
          items={[
            ["Status", <StatusBadge key="status" status={account.status} />],
            ["Balance on chain", <Money key="balance" value={account.chainBalance} />],
            ["Sent today", <Money key="spent" value={account.spentToday} />],
            ["Opened", formatDateTime(account.openedAt)],
          ]}
        />
        <Facts
          items={[
            ["Per transaction", account.limits ? unlimited(account.limits.perTransaction) : "-"],
            ["Per day", account.limits ? unlimited(account.limits.dailyOutflow) : "-"],
            ["Maximum balance", account.limits ? unlimited(account.limits.maxBalance) : "-"],
            ["Freeze reference", account.statusReason ?? "-"],
          ]}
        />
      </div>
      <p className="font-mono text-xs break-all text-ink-3">{account.address}</p>

      {isCustomer && (ownAccount || mayFreeze) && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-sunken px-4 py-3">
          {ownAccount && account.status === "Active" && (
            <>
              <Field label="Amount in taka">
                <Input
                  className="w-36"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </Field>
              <Button
                disabled={!amount || command.isPending}
                onClick={() => command.mutate({ path: `${base}/cash-in`, done: "Wallet credited", body: { amount } })}
              >
                Cash in
              </Button>
              <Button
                disabled={!amount || command.isPending}
                onClick={() =>
                  command.mutate({ path: `${base}/cash-out`, done: "Funds returned to settlement", body: { amount } })
                }
              >
                Cash out
              </Button>
            </>
          )}
          {mayFreeze && account.status === "Active" && (
            <>
              <Field label="Case reference">
                <Input
                  className="w-44"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={31}
                />
              </Field>
              <Button
                variant="danger"
                disabled={!reason || command.isPending}
                onClick={() => command.mutate({ path: `${base}/freeze`, done: "Account frozen", body: { reason } })}
              >
                Freeze
              </Button>
            </>
          )}
          {mayFreeze && account.status === "Frozen" && (
            <Button
              disabled={command.isPending}
              onClick={() => command.mutate({ path: `${base}/unfreeze`, done: "Freeze lifted" })}
            >
              Lift freeze
            </Button>
          )}
        </div>
      )}

      <div className="-mx-5 max-h-72 overflow-y-auto border-t border-line">
        <DataTable
          rowKey={(movement) => `${movement.txHash}-${movement.counterparty}-${movement.amount}`}
          rows={account.movements}
          empty="No movement on this account yet."
          columns={[
            {
              header: "When",
              cell: (movement) => (
                <span className="whitespace-nowrap text-ink-2">{formatDateTime(movement.blockTime)}</span>
              ),
            },
            { header: "Direction", cell: (movement) => <Tag>{movement.incoming ? "Received" : "Sent"}</Tag> },
            {
              header: "Counterparty",
              cell: (movement) => <Party label={movement.counterpartyLabel} address={movement.counterparty} />,
            },
            {
              header: "Amount",
              align: "right",
              cell: (movement) => (
                <span className="figures whitespace-nowrap">
                  {movement.incoming ? "+" : "−"}
                  {formatTaka(movement.amount)}
                </span>
              ),
            },
            { header: "Transaction", cell: (movement) => <TxHash hash={movement.txHash} /> },
          ]}
        />
      </div>
    </Dialog>
  );
}

function AccountsTab({ institutions }: { institutions: Institution[] }) {
  const [institution, setInstitution] = useState("");
  const [tier, setTier] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const query = new URLSearchParams({ limit: "200" });
  if (institution) query.set("institution", institution);
  if (tier) query.set("tier", tier);
  if (search.trim()) query.set("search", search.trim());
  const accounts = useApi<Account[]>(`/v1/accounts?${query}`);

  const columns: Column<Account>[] = [
    {
      header: "Account",
      cell: (account) => <Party label={account.label} address={account.address} note={account.district} />,
    },
    { header: "Institution", cell: (account) => account.institutionName },
    { header: "Tier", cell: (account) => <Tag>{account.tier}</Tag> },
    { header: "Status", cell: (account) => <StatusBadge status={account.status} /> },
    { header: "Balance", align: "right", cell: (account) => <Money value={account.balance} /> },
  ];

  return (
    <Card
      title="Accounts"
      subtitle="Select an account to see its limits and movements."
      flush
      actions={
        <>
          <Input
            className="w-44"
            placeholder="Search name or wallet"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            className="w-48"
            value={institution}
            onChange={(event) => setInstitution(event.target.value)}
            aria-label="Institution"
          >
            <option value="">All institutions</option>
            {institutions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
          <Select className="w-36" value={tier} onChange={(event) => setTier(event.target.value)} aria-label="Tier">
            <option value="">All tiers</option>
            {["Basic", "Full", "Merchant", "Corporate", "Institution"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </Select>
        </>
      }
    >
      <DataTable
        rowKey={(account) => account.address}
        rows={accounts.data}
        columns={columns}
        onRowClick={(account) => setOpen(account.address)}
      />
      {open && <AccountDialog address={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

// ------------------------------------------------------------------ merchants

function QrDialog({ merchant, onClose }: { merchant: Merchant; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [code, setCode] = useState<{ payload: string; svg: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const build = async () => {
    setError(null);
    try {
      setCode(
        await api.post<{ payload: string; svg: string }>(`/v1/merchants/${merchant.id}/qr`, {
          amount: amount || undefined,
          invoiceRef: invoiceRef || undefined,
        }),
      );
    } catch (failure) {
      setCode(null);
      setError(describeError(failure));
    }
  };

  return (
    <Dialog
      wide
      open
      onClose={onClose}
      title={`Bangla QR for ${merchant.name}`}
      description="Leave the amount empty for a static code the customer fills in, or set it for a single invoice."
    >
      <div className="grid gap-6 md:grid-cols-[1fr_15rem]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Amount in taka">
              <Input
                inputMode="decimal"
                placeholder="Static code"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </Field>
            <Field label="Invoice number">
              <Input value={invoiceRef} onChange={(event) => setInvoiceRef(event.target.value)} maxLength={25} />
            </Field>
          </div>
          <Button variant="primary" onClick={build}>
            Generate code
          </Button>
          {error && <p className="text-sm text-critical">{error}</p>}
          {code && (
            <Field
              label="Payload"
              hint="EMVCo merchant-presented format: taka (050), Bangladesh (BD), CRC-16 checksum."
            >
              <textarea
                readOnly
                rows={5}
                value={code.payload}
                onFocus={(event) => event.target.select()}
                className="w-full rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs break-all"
              />
            </Field>
          )}
        </div>
        <div className="qr flex aspect-square items-center justify-center rounded-lg border border-line bg-white p-3">
          {code ? (
            <div className="w-full" dangerouslySetInnerHTML={{ __html: code.svg }} />
          ) : (
            <span className="text-xs text-ink-3">The code appears here</span>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function MerchantsTab() {
  const merchants = useApi<Merchant[]>("/v1/merchants");
  const [qrFor, setQrFor] = useState<Merchant | null>(null);

  const columns: Column<Merchant>[] = [
    {
      header: "Merchant",
      cell: (merchant) => (
        <span>
          <span className="font-medium">{merchant.name}</span>
          <span className="block text-xs text-ink-3">
            {merchant.id} &middot; {merchant.city}
          </span>
        </span>
      ),
    },
    { header: "Category", cell: (merchant) => `${merchant.category} (${merchant.categoryCode})` },
    { header: "Acquirer", cell: (merchant) => merchant.acquirerName },
    { header: "Fee", align: "right", cell: (merchant) => formatBps(merchant.feeBps) },
    { header: "Payments", align: "right", cell: (merchant) => merchant.payments },
    { header: "Volume", align: "right", cell: (merchant) => <Money value={merchant.volume} /> },
    { header: "Status", cell: (merchant) => <StatusBadge status={merchant.active ? "Active" : "Suspended"} /> },
    {
      header: "",
      align: "right",
      cell: (merchant) => (
        <Button small onClick={() => setQrFor(merchant)}>
          QR code
        </Button>
      ),
    },
  ];

  return (
    <Card
      title="Merchants"
      subtitle="Onboarded by their acquiring institution. The fee follows the merchant category."
      flush
    >
      <DataTable rowKey={(merchant) => merchant.id} rows={merchants.data} columns={columns} />
      {qrFor && <QrDialog merchant={qrFor} onClose={() => setQrFor(null)} />}
    </Card>
  );
}

// ------------------------------------------------------------------ institutions and policy

function InstitutionsTab({ institutions }: { institutions: Institution[] | undefined }) {
  const columns: Column<Institution>[] = [
    {
      header: "Institution",
      cell: (item) => (
        <span>
          <span className="font-medium">{item.name}</span>
          <span className="block text-xs text-ink-3">
            {item.id} &middot; {item.country}
          </span>
        </span>
      ),
    },
    { header: "Licence category", cell: (item) => humanise(item.kind) },
    { header: "Status", cell: (item) => <StatusBadge status={item.active ? "Active" : "Suspended"} /> },
    { header: "Settlement balance", align: "right", cell: (item) => <Money value={item.settlementBalance} /> },
    { header: "Customer accounts", align: "right", cell: (item) => item.customerAccounts },
    { header: "Customer balances", align: "right", cell: (item) => <Money value={item.customerBalances} muted /> },
  ];
  return (
    <Card
      title="Member institutions"
      subtitle="Admitted by the network operator. Suspending an institution suspends every account it sponsors."
      flush
    >
      <DataTable rowKey={(item) => item.id} rows={institutions} columns={columns} />
    </Card>
  );
}

function PolicyTab() {
  const { data: policy } = useApi<Policy>("/v1/policy");
  if (!policy) return <Loading />;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card
        title="Limits by KYC tier"
        subtitle="Enforced by the token on every movement. The business day rolls over at midnight in Dhaka."
        flush
      >
        <DataTable
          rowKey={(row) => row.tier}
          rows={policy.tierLimits}
          columns={[
            { header: "Tier", cell: (row) => <Tag>{row.tier}</Tag> },
            { header: "Per transaction", align: "right", cell: (row) => unlimited(row.perTransaction) },
            { header: "Per day", align: "right", cell: (row) => unlimited(row.dailyOutflow) },
            { header: "Maximum balance", align: "right", cell: (row) => unlimited(row.maxBalance) },
          ]}
        />
      </Card>
      <Card
        title="Merchant fees"
        subtitle={
          policy.feeSchedule
            ? `Default ${formatBps(policy.feeSchedule.defaultFeeBps)}; the acquirer keeps ${formatBps(policy.feeSchedule.acquirerShareBps)} of each fee.`
            : undefined
        }
        flush
      >
        <DataTable
          rowKey={(row) => row.categoryCode}
          rows={policy.categoryFees}
          columns={[
            { header: "Category", cell: (row) => row.category },
            { header: "Code", cell: (row) => <span className="font-mono text-xs">{row.categoryCode}</span> },
            { header: "Fee", align: "right", cell: (row) => formatBps(row.feeBps) },
          ]}
        />
      </Card>
    </div>
  );
}

export function DirectoryPage() {
  const [tab, setTab] = useState<Tab>("institutions");
  const [opening, setOpening] = useState(false);
  const institutions = useApi<Institution[]>("/v1/institutions");

  return (
    <>
      <PageHeader
        title="Directory"
        description="Who is on the network: licensed institutions, the accounts they sponsor, merchants and the policy that applies to them."
        actions={
          <RoleGate roles={["institution_admin"]}>
            <Button variant="primary" onClick={() => setOpening(true)}>
              Open an account
            </Button>
          </RoleGate>
        }
      />
      <div className="mb-4">
        <Segmented label="Directory section" value={tab} options={TABS} onChange={setTab} />
      </div>
      {tab === "institutions" && <InstitutionsTab institutions={institutions.data} />}
      {tab === "accounts" && <AccountsTab institutions={institutions.data ?? []} />}
      {tab === "merchants" && <MerchantsTab />}
      {tab === "policy" && <PolicyTab />}
      {opening && <OpenAccountDialog onClose={() => setOpening(false)} />}
    </>
  );
}
