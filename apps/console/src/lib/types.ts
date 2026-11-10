/** Shapes returned by the settlement API. Amounts are poisha as decimal strings. */

export type OperatorRole =
  | "network_operator"
  | "supervisor"
  | "issuance_maker"
  | "reserve_checker"
  | "reserve_auditor"
  | "compliance_officer"
  | "institution_admin"
  | "exchange_house"
  | "treasury";

export interface Operator {
  username: string;
  displayName: string;
  role: OperatorRole;
  institutionId: string | null;
  address: string;
}

export interface OperatorProfile {
  username: string;
  displayName: string;
  role: OperatorRole;
  institutionId: string | null;
  institutionName: string | null;
}

export interface DailyActivity {
  businessDate: string;
  merchantPayments: number | string;
  merchantVolume: string;
  personTransfers: number | string;
  transferVolume: string;
  remittances: number | string;
  remittanceVolume: string;
  disbursements: number | string;
  disbursementVolume: string;
}

export interface ReconciliationRun {
  id: string;
  runAt: string;
  blockNumber: string;
  totalSupply: string;
  ledgerLiabilities: string;
  ledgerReserve: string;
  reportedReserve: string | null;
  walletsChecked: number;
  mismatches: { wallet: string; ledger: string; chain: string }[];
  status: "Balanced" | "Mismatch";
  triggeredBy: string;
}

export interface ActivityItem {
  type: string;
  at: string;
  txHash: string;
  amount: string;
  actor: string;
  counterparty: string;
}

export interface Overview {
  headline: {
    supply: string;
    reserve: string | null;
    reserveAsOf: string | null;
    incentivePool: string | null;
    institutions: number;
    activeAccounts: number;
    merchants: number;
    indexedBlock: string;
    indexedBlockTime: string | null;
  };
  today: DailyActivity | null;
  series: DailyActivity[];
  corridors: { corridorId: string; currency: string; remittances: number; amount: string }[];
  pending: { issuance: number; redemptions: number; remittances: number; batches: number; frozenAccounts: number };
  reconciliation: ReconciliationRun | null;
  activity: ActivityItem[];
}

export interface Institution {
  id: string;
  kind: string;
  name: string;
  country: string;
  active: boolean;
  settlementAccount: string;
  settlementBalance: string;
  customerAccounts: number;
  customerBalances: string;
}

export interface Account {
  address: string;
  institutionId: string;
  institutionName: string;
  tier: string;
  status: "Active" | "Frozen" | "Closed";
  statusReason: string | null;
  openedAt: string;
  label: string | null;
  district: string | null;
  balance: string;
  inCustody: boolean;
}

export interface AccountDetail extends Account {
  chainBalance: string;
  spentToday: string;
  limits: { perTransaction: string; dailyOutflow: string; maxBalance: string } | null;
  movements: {
    blockTime: string;
    txHash: string;
    amount: string;
    incoming: boolean;
    counterparty: string;
    counterpartyLabel: string | null;
  }[];
}

export interface Merchant {
  id: string;
  acquirerId: string;
  acquirerName: string;
  account: string;
  categoryCode: number;
  category: string;
  active: boolean;
  name: string;
  city: string | null;
  feeBps: number;
  balance: string;
  payments: number;
  volume: string;
}

export interface Policy {
  tierLimits: { tier: string; perTransaction: string; dailyOutflow: string; maxBalance: string }[];
  feeSchedule: { defaultFeeBps: number; acquirerShareBps: number } | null;
  categoryFees: { categoryCode: number; feeBps: number; category: string }[];
  gateway: {
    incentiveBps: number;
    rateBandBps: number;
    rateValidity: number;
    reviewWindow: number;
    screeningThreshold: string;
    incentivePool: string;
  } | null;
}

export interface Payment {
  id: string;
  kind: "merchant" | "person";
  payer: string;
  payerLabel: string | null;
  payerInstitution: string | null;
  payee: string;
  payeeLabel: string | null;
  payeeInstitution: string | null;
  merchantId: string | null;
  amount: string;
  acquirerFee: string;
  networkFee: string;
  refunded: string;
  reference: string | null;
  purpose: string | null;
  settledAt: string;
  txHash: string;
}

export interface Corridor {
  id: string;
  currency: string;
  active: boolean;
  maxAmount: string;
  referenceRate: string | null;
  rateUpdatedAt: string | null;
  originators: { id: string; name: string }[];
  paidCount: number;
  paidAmount: string;
  paidSourceAmount: string;
  underReview: number;
}

export type RemittanceStatus = "UnderReview" | "Paid" | "Rejected" | "Reclaimed";

export interface Remittance {
  id: string;
  corridorId: string;
  currency: string;
  originatorId: string;
  originatorName: string;
  beneficiary: string;
  beneficiaryLabel: string | null;
  beneficiaryDistrict: string | null;
  beneficiaryInstitution: string | null;
  amount: string;
  incentive: string;
  incentivePaid: boolean;
  sourceAmount: string;
  rate: string;
  purpose: string;
  senderRef: string;
  status: RemittanceStatus;
  reason: string | null;
  createdAt: string;
  settledAt: string | null;
  txHash: string;
}

export interface Quote {
  corridor: string;
  currency: string;
  sourceAmount: string;
  rate: string;
  amount: string;
  incentive: string;
}

export type RequestStatus = "Pending" | "Completed" | "Rejected";

export interface Reserves {
  totalSupply: string;
  statements: {
    idx: number;
    asOf: string;
    balance: string;
    documentHash: string;
    publisher: string;
    publishedAt: string;
    txHash: string;
  }[];
  issuance: {
    id: string;
    institutionId: string;
    institutionName: string;
    amount: string;
    fundingRef: string;
    status: RequestStatus;
    reason: string | null;
    requestedAt: string;
    decidedAt: string | null;
    txHash: string;
  }[];
  redemptions: {
    id: string;
    institutionId: string;
    institutionName: string;
    amount: string;
    payoutRef: string;
    status: RequestStatus;
    reason: string | null;
    requestedAt: string;
    decidedAt: string | null;
    txHash: string;
  }[];
}

export interface Coverage {
  supply: string;
  days: { businessDate: string; supply: string; reserve: string | null }[];
}

export type BatchStatus = "AwaitingApproval" | "Approved" | "Rejected" | "Closed";

export interface Batch {
  id: string;
  payer: string;
  payerLabel: string | null;
  payerInstitutionId: string;
  payerInstitutionName: string;
  batchRef: string;
  merkleRoot: string;
  total: string;
  paid: string;
  failed: string;
  returned: string | null;
  payoutCount: number;
  processed: number;
  purpose: string;
  status: BatchStatus;
  reason: string | null;
  createdAt: string;
  approvedAt: string | null;
  closedAt: string | null;
  txHash: string;
}

export interface BatchDetail extends Batch {
  payouts: {
    idx: number;
    account: string;
    label: string | null;
    institutionId: string | null;
    accountStatus: string | null;
    amount: string;
    status: "Pending" | "Settled" | "Failed";
    processedAt: string | null;
    txHash: string | null;
  }[];
}

export interface TrialBalance {
  totals: { assets: string; liabilities: string; totalDebits: string; totalCredits: string; entries: number };
  liabilities: { institutionId: string; institutionName: string; tier: string; wallets: number; balance: string }[];
}

export interface JournalEntry {
  id: string;
  entryType: "issuance" | "redemption" | "transfer";
  blockNumber: string;
  postedAt: string;
  txHash: string;
  amount: string;
  debitCode: string;
  debitAccount: string;
  creditCode: string;
  creditAccount: string;
}

export interface SettlementReport {
  date: string;
  dates: string[];
  positions: {
    institutionId: string;
    institutionName: string;
    kind: string;
    inflow: string;
    outflow: string;
    netPosition: string;
  }[];
  flows: { fromInstitution: string; toInstitution: string; flowType: string; movements: number; amount: string }[];
}

export interface AuditEntry {
  id: string;
  operator: string;
  displayName: string | null;
  action: string;
  signer: string | null;
  details: Record<string, unknown>;
  outcome: "Accepted" | "Rejected";
  txHash: string | null;
  error: string | null;
  createdAt: string;
}

export interface DistrictRow {
  district: string;
  remittances: number;
  amount: string;
}
