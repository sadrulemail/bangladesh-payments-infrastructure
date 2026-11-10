/**
 * Enumerations shared with the contracts. The position of each name is its on-chain value.
 */

export const INSTITUTION_KINDS = [
  "None",
  "NetworkOperator",
  "SettlementBank",
  "CommercialBank",
  "MobileFinancialService",
  "PaymentServiceProvider",
  "ExchangeHouse",
  "Treasury",
] as const;
export type InstitutionKind = (typeof INSTITUTION_KINDS)[number];

export const TIERS = ["None", "Basic", "Full", "Merchant", "Corporate", "Institution", "System"] as const;
export type Tier = (typeof TIERS)[number];

/** Tiers an institution may give to its own customers. */
export const CUSTOMER_TIERS = ["Basic", "Full", "Merchant", "Corporate"] as const satisfies readonly Tier[];
export type CustomerTier = (typeof CUSTOMER_TIERS)[number];

export const ACCOUNT_STATUSES = ["None", "Active", "Frozen", "Closed"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const REQUEST_STATUSES = ["None", "Pending", "Completed", "Rejected"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REMITTANCE_STATUSES = ["None", "UnderReview", "Paid", "Rejected", "Reclaimed"] as const;
export type RemittanceStatus = (typeof REMITTANCE_STATUSES)[number];

export const BATCH_STATUSES = ["None", "AwaitingApproval", "Approved", "Rejected", "Closed"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/** Reads the name of an on-chain enum value. */
export function enumName<const T extends readonly string[]>(names: T, value: number | bigint): T[number] {
  const name = names[Number(value)];
  if (name === undefined) throw new RangeError(`Enum value ${value} is out of range`);
  return name;
}

/** Returns the on-chain value of an enum name. */
export function enumValue<const T extends readonly string[]>(names: T, name: T[number]): number {
  const value = names.indexOf(name);
  if (value < 0) throw new RangeError(`"${name}" is not a member of the enum`);
  return value;
}

/** ISO 20022 purpose codes used on the network. */
export const PURPOSE_CODES = {
  FAMI: "Family maintenance",
  EDUC: "Education",
  MDCS: "Medical services",
  SAVG: "Savings",
  SALA: "Salary payment",
  SSBE: "Social security benefit",
  SUPP: "Supplier payment",
  GDDS: "Purchase of goods",
  OTHR: "Other",
} as const;
export type PurposeCode = keyof typeof PURPOSE_CODES;

/** ISO 18245 merchant category codes in use on the network. */
export const MERCHANT_CATEGORIES: Record<number, string> = {
  4131: "Bus lines",
  5261: "Farm and garden supplies",
  5411: "Grocery stores and supermarkets",
  5814: "Tea stalls and quick-service food",
  5912: "Pharmacies",
  5947: "Handicraft and gift shops",
};

/** ISO 4217 numeric code of the taka and ISO 3166 code of Bangladesh, as used in QR payloads. */
export const BDT_NUMERIC_CODE = "050";
export const BANGLADESH_COUNTRY_CODE = "BD";
