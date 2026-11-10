import assert from "node:assert/strict";

import { fromAscii, fromCode, toAscii, toCode, toReference } from "../src/codes";

describe("codes", () => {
  it("packs a short code into bytes32 and reads it back", () => {
    const packed = toCode("AE-BD");

    assert.equal(packed.length, 66);
    assert.ok(packed.startsWith("0x41452d4244"));
    assert.equal(fromCode(packed), "AE-BD");
  });

  it("refuses codes that are too long or not printable ASCII", () => {
    assert.throws(() => toCode("X".repeat(32)), RangeError);
    assert.throws(() => toCode("টাকা"), RangeError);
  });

  it("keeps a short reference readable and hashes a long one", () => {
    const short = toReference("INV-2026-000451");
    const long = toReference("PURCHASE-ORDER-2026-11-NARAYANGANJ-000451");

    assert.equal(fromCode(short), "INV-2026-000451");
    assert.equal(long.length, 66);
    assert.equal(fromCode(long), long);
  });

  it("maps an empty reference to zero", () => {
    assert.equal(toReference(""), `0x${"0".repeat(64)}`);
    assert.equal(fromCode(`0x${"0".repeat(64)}`), "");
  });

  it("packs fixed-width codes", () => {
    assert.equal(toAscii("FAMI", 4), "0x46414d49");
    assert.equal(fromAscii("0x414544"), "AED");
    assert.throws(() => toAscii("AE", 3), RangeError);
  });
});
