/**
 * Merchant-presented QR payloads in the EMVCo format that Bangla QR is built on.
 *
 * A payload is a sequence of tag-length-value fields closed by a CRC-16 checksum. The merchant's
 * network identity travels in a merchant account template (tag 26) under the TakaRail identifier,
 * so any wallet on the network can resolve the payee from the code alone.
 */
import { BANGLADESH_COUNTRY_CODE, BDT_NUMERIC_CODE } from "./domain";

export const TAKARAIL_QR_IDENTIFIER = "bd.takarail";

const TAG = {
  payloadFormat: "00",
  initiationMethod: "01",
  merchantAccount: "26",
  categoryCode: "52",
  currency: "53",
  amount: "54",
  country: "58",
  merchantName: "59",
  merchantCity: "60",
  additionalData: "62",
  crc: "63",
} as const;

const ACCOUNT_TAG = { identifier: "00", merchantId: "01", acquirer: "02" } as const;
const ADDITIONAL_TAG = { billNumber: "01", terminal: "07" } as const;

const PAYLOAD_FORMAT = "01";
const STATIC_CODE = "11";
const DYNAMIC_CODE = "12";
const TAG_FORMAT = /^\d{2}$/;
const AMOUNT_FORMAT = /^\d{1,10}(\.\d{1,2})?$/;
const PRINTABLE = /^[\x20-\x7e]*$/;

export interface MerchantQr {
  merchantId: string;
  /** Code of the acquiring institution. */
  acquirer: string;
  merchantName: string;
  merchantCity: string;
  /** ISO 18245 merchant category code. */
  categoryCode: number;
  /** Decimal taka amount. Present on a dynamic code, absent on a static one. */
  amount?: string;
  /** Invoice or bill number. A payment that carries it settles once. */
  invoiceRef?: string;
  terminal?: string;
}

export class QrFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrFormatError";
  }
}

/** CRC-16/CCITT-FALSE, as EMVCo specifies: polynomial 0x1021, initial value 0xFFFF. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function field(tag: string, value: string, maxLength = 99): string {
  if (!PRINTABLE.exec(value)) throw new QrFormatError(`Field ${tag} holds characters outside printable ASCII`);
  if (value.length === 0 || value.length > maxLength) {
    throw new QrFormatError(`Field ${tag} must hold 1 to ${maxLength} characters`);
  }
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

function parseFields(payload: string): Map<string, string> {
  const fields = new Map<string, string>();
  let cursor = 0;
  while (cursor < payload.length) {
    const tag = payload.slice(cursor, cursor + 2);
    const length = Number(payload.slice(cursor + 2, cursor + 4));
    const value = payload.slice(cursor + 4, cursor + 4 + length);
    if (!TAG_FORMAT.exec(tag) || !Number.isInteger(length) || value.length !== length) {
      throw new QrFormatError(`Malformed field at position ${cursor}`);
    }
    fields.set(tag, value);
    cursor += 4 + length;
  }
  return fields;
}

function required(fields: Map<string, string>, tag: string, name: string): string {
  const value = fields.get(tag);
  if (value === undefined) throw new QrFormatError(`The code has no ${name}`);
  return value;
}

/** Builds the payload of a merchant QR code. */
export function encodeMerchantQr(qr: MerchantQr): string {
  if (qr.amount !== undefined && !AMOUNT_FORMAT.exec(qr.amount)) {
    throw new QrFormatError(`"${qr.amount}" is not a taka amount`);
  }

  const account =
    field(ACCOUNT_TAG.identifier, TAKARAIL_QR_IDENTIFIER, 32) +
    field(ACCOUNT_TAG.merchantId, qr.merchantId, 31) +
    field(ACCOUNT_TAG.acquirer, qr.acquirer, 16);
  const additional =
    (qr.invoiceRef ? field(ADDITIONAL_TAG.billNumber, qr.invoiceRef, 25) : "") +
    (qr.terminal ? field(ADDITIONAL_TAG.terminal, qr.terminal, 25) : "");

  const body =
    field(TAG.payloadFormat, PAYLOAD_FORMAT) +
    field(TAG.initiationMethod, qr.amount === undefined ? STATIC_CODE : DYNAMIC_CODE) +
    field(TAG.merchantAccount, account) +
    field(TAG.categoryCode, String(qr.categoryCode).padStart(4, "0"), 4) +
    field(TAG.currency, BDT_NUMERIC_CODE) +
    (qr.amount === undefined ? "" : field(TAG.amount, qr.amount, 13)) +
    field(TAG.country, BANGLADESH_COUNTRY_CODE) +
    field(TAG.merchantName, qr.merchantName, 25) +
    field(TAG.merchantCity, qr.merchantCity, 15) +
    (additional ? field(TAG.additionalData, additional) : "") +
    `${TAG.crc}04`;

  return body + crc16(body);
}

/** Reads a merchant QR payload back, after verifying its checksum, currency and country. */
export function decodeMerchantQr(payload: string): MerchantQr {
  const text = payload.trim();
  const body = text.slice(0, -4);
  if (!body.endsWith(`${TAG.crc}04`) || crc16(body) !== text.slice(-4).toUpperCase()) {
    throw new QrFormatError("The checksum of the code does not match");
  }

  const fields = parseFields(text);
  if (fields.get(TAG.payloadFormat) !== PAYLOAD_FORMAT) throw new QrFormatError("Unsupported payload format");
  if (fields.get(TAG.currency) !== BDT_NUMERIC_CODE) throw new QrFormatError("The code is not denominated in taka");
  if (fields.get(TAG.country) !== BANGLADESH_COUNTRY_CODE) throw new QrFormatError("The code is not a Bangladesh code");

  const account = parseFields(required(fields, TAG.merchantAccount, "merchant account"));
  if (account.get(ACCOUNT_TAG.identifier) !== TAKARAIL_QR_IDENTIFIER) {
    throw new QrFormatError("The code does not carry a TakaRail merchant account");
  }
  const additional = parseFields(fields.get(TAG.additionalData) ?? "");

  return {
    merchantId: required(account, ACCOUNT_TAG.merchantId, "merchant id"),
    acquirer: required(account, ACCOUNT_TAG.acquirer, "acquirer"),
    merchantName: required(fields, TAG.merchantName, "merchant name"),
    merchantCity: required(fields, TAG.merchantCity, "merchant city"),
    categoryCode: Number(required(fields, TAG.categoryCode, "category code")),
    amount: fields.get(TAG.amount),
    invoiceRef: additional.get(ADDITIONAL_TAG.billNumber),
    terminal: additional.get(ADDITIONAL_TAG.terminal),
  };
}
