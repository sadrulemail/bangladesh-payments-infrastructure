import assert from "node:assert/strict";

import {
  basisPoints,
  compactTaka,
  convertToTaka,
  formatRate,
  formatTaka,
  groupLakh,
  parseRate,
  parseTaka,
} from "../src/money";

describe("money", () => {
  it("parses taka amounts into poisha", () => {
    assert.equal(parseTaka("1,250.50"), 125_050n);
    assert.equal(parseTaka("0.05"), 5n);
    assert.equal(parseTaka(300), 30_000n);
  });

  it("rejects amounts that are not plain decimals with at most two places", () => {
    for (const value of ["12.345", "abc", "-5", "", "1e3", "1.2.3"]) {
      assert.throws(() => parseTaka(value), RangeError, value);
    }
  });

  it("groups digits in lakh and crore", () => {
    assert.equal(groupLakh("999"), "999");
    assert.equal(groupLakh("1000"), "1,000");
    assert.equal(groupLakh("1234567"), "12,34,567");
    assert.equal(groupLakh("123456789"), "12,34,56,789");
  });

  it("formats poisha for display", () => {
    assert.equal(formatTaka(123_456_789n), "৳12,34,567.89");
    assert.equal(formatTaka("5"), "৳0.05");
    assert.equal(formatTaka(-250_000n), "-৳2,500.00");
    assert.equal(formatTaka(100n, { symbol: false }), "1.00");
  });

  it("shortens large amounts to lakh and crore", () => {
    assert.equal(compactTaka(parseTaka("34200000")), "৳3.42 crore");
    assert.equal(compactTaka(parseTaka("250000")), "৳2.50 lakh");
    assert.equal(compactTaka(parseTaka("99999.99")), "৳99,999.99");
  });

  it("converts foreign currency at a scaled rate, rounding down", () => {
    assert.equal(convertToTaka(100_000n, parseRate("33.25")), 3_325_000n);
    assert.equal(convertToTaka(1n, parseRate("33.259999")), 33n);
    assert.equal(formatRate(parseRate("122.4")), "122.4000");
  });

  it("takes a share in basis points, rounding down", () => {
    assert.equal(basisPoints(3_325_000n, 250), 83_125n);
    assert.equal(basisPoints(99n, 100), 0n);
  });
});
