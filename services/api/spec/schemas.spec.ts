import assert from "node:assert/strict";

import { address, exchangeRate, reference, shortCode, takaAmount } from "../src/http/schemas";

describe("Input schemas", () => {
  it("reads a taka amount as poisha", () => {
    assert.equal(takaAmount.parse("1,250.50"), 125_050n);
    assert.equal(takaAmount.parse("0.01"), 1n);
    assert.equal(takaAmount.parse(12), 1_200n);
  });

  it("refuses an amount that is empty, not positive or finer than a poisha", () => {
    for (const value of ["", "0", "0.00", "-5", "1.234", "12a", "1e3"]) {
      assert.equal(takaAmount.safeParse(value).success, false, value);
    }
  });

  it("reads an exchange rate with up to six decimals as its scaled integer", () => {
    assert.equal(exchangeRate.parse("33.25"), 33_250_000n);
    assert.equal(exchangeRate.parse("122.400001"), 122_400_001n);
    assert.equal(exchangeRate.safeParse("33.2500001").success, false);
  });

  it("normalises a wallet address to lower case and refuses anything else", () => {
    assert.equal(
      address.parse("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"),
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
    assert.equal(address.safeParse("0x1234").success, false);
    assert.equal(address.safeParse("AbCdEf0123456789aBcDeF0123456789AbCdEf0123").success, false);
  });

  it("keeps references and codes short enough for a bytes32 on chain", () => {
    assert.equal(reference.parse("  INV-2026-000451 "), "INV-2026-000451");
    assert.equal(reference.safeParse("R".repeat(32)).success, false);
    assert.equal(reference.safeParse("নকশি").success, false);
    assert.equal(shortCode.parse("AE-BD"), "AE-BD");
    assert.equal(shortCode.safeParse("surma").success, false);
  });
});
