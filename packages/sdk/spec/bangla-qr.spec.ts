import assert from "node:assert/strict";

import { type MerchantQr, QrFormatError, crc16, decodeMerchantQr, encodeMerchantQr } from "../src/bangla-qr";

const NAKSHI: MerchantQr = {
  merchantId: "NAKSHI-01",
  acquirer: "SURMA",
  merchantName: "Nakshi Handicrafts",
  merchantCity: "Dhaka",
  categoryCode: 5947,
};

/** Replaces part of a payload and recomputes its checksum. */
function rewrite(payload: string, search: string, replacement: string): string {
  const body = payload.slice(0, -4).replace(search, replacement);
  return body + crc16(body);
}

describe("Bangla QR", () => {
  it("computes the EMVCo checksum", () => {
    assert.equal(crc16("123456789"), "29B1");
  });

  it("encodes a static merchant code", () => {
    const payload = encodeMerchantQr(NAKSHI);

    assert.ok(payload.startsWith("000201010211"));
    assert.ok(payload.includes("0011bd.takarail0109NAKSHI-010205SURMA"));
    assert.ok(payload.includes("52045947"));
    assert.ok(payload.includes("5303050"));
    assert.ok(payload.includes("5802BD"));
    assert.ok(!payload.includes("5406"));
    assert.deepEqual(decodeMerchantQr(payload), {
      ...NAKSHI,
      amount: undefined,
      invoiceRef: undefined,
      terminal: undefined,
    });
  });

  it("encodes a dynamic code with an amount and an invoice", () => {
    const invoice = { ...NAKSHI, amount: "2450.00", invoiceRef: "INV-2026-000451", terminal: "POS-02" };
    const payload = encodeMerchantQr(invoice);

    assert.ok(payload.startsWith("000201010212"));
    assert.ok(payload.includes("54072450.00"));
    assert.deepEqual(decodeMerchantQr(payload), invoice);
  });

  it("pads the category code to four digits", () => {
    assert.ok(encodeMerchantQr({ ...NAKSHI, categoryCode: 742 }).includes("52040742"));
  });

  it("rejects a payload whose checksum does not match", () => {
    const payload = encodeMerchantQr({ ...NAKSHI, amount: "2450.00" });
    const tampered = payload.replace("54072450.00", "54072450.99");

    assert.throws(() => decodeMerchantQr(tampered), QrFormatError);
    assert.throws(() => decodeMerchantQr(payload.slice(0, -1)), QrFormatError);
  });

  it("rejects a code in another currency, country or scheme", () => {
    const payload = encodeMerchantQr(NAKSHI);

    assert.throws(() => decodeMerchantQr(rewrite(payload, "5303050", "5303840")), /taka/);
    assert.throws(() => decodeMerchantQr(rewrite(payload, "5802BD", "5802IN")), /Bangladesh/);
    assert.throws(() => decodeMerchantQr(rewrite(payload, "bd.takarail", "bd.otherpay")), /TakaRail/);
  });

  it("refuses values the format cannot carry", () => {
    assert.throws(() => encodeMerchantQr({ ...NAKSHI, merchantName: "নকশি" }), QrFormatError);
    assert.throws(() => encodeMerchantQr({ ...NAKSHI, merchantCity: "" }), QrFormatError);
    assert.throws(() => encodeMerchantQr({ ...NAKSHI, merchantName: "N".repeat(26) }), QrFormatError);
    assert.throws(() => encodeMerchantQr({ ...NAKSHI, amount: "12.345" }), QrFormatError);
  });
});
