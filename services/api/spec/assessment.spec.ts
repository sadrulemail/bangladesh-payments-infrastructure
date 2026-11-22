import assert from "node:assert/strict";

import { type ReconciliationFigures, assess } from "../src/ledger/assessment";

const SHOP = "0x00000000000000000000000000000000000000a1";
const WORKER = "0x00000000000000000000000000000000000000b2";

/** Figures of a network whose ledger, chain and reserve statement all agree. */
function agreeing(): ReconciliationFigures {
  return {
    ledger: [
      { wallet: SHOP, balance: 70_000n },
      { wallet: WORKER, balance: 30_000n },
    ],
    chain: new Map([
      [SHOP, 70_000n],
      [WORKER, 30_000n],
    ]),
    totalSupply: 100_000n,
    ledgerReserve: 100_000n,
    reportedReserve: 150_000n,
  };
}

describe("Reconciliation assessment", () => {
  it("is balanced when ledger and chain agree and the reserve statement covers supply", () => {
    const outcome = assess(agreeing());

    assert.equal(outcome.status, "Balanced");
    assert.deepEqual(outcome.mismatches, []);
    assert.equal(outcome.liabilities, 100_000n);
  });

  it("names each wallet whose ledger balance differs from the chain", () => {
    const chain = new Map([
      [SHOP, 69_500n],
      [WORKER, 30_000n],
    ]);
    const outcome = assess({ ...agreeing(), chain });

    assert.equal(outcome.status, "Mismatch");
    assert.deepEqual(outcome.mismatches, [{ wallet: SHOP, ledger: "70000", chain: "69500" }]);
  });

  it("counts a wallet the chain does not report as holding nothing", () => {
    const outcome = assess({ ...agreeing(), chain: new Map([[SHOP, 70_000n]]) });

    assert.deepEqual(outcome.mismatches, [{ wallet: WORKER, ledger: "30000", chain: "0" }]);
  });

  it("reports a mismatch when liabilities or the reserve asset differ from supply", () => {
    assert.equal(assess({ ...agreeing(), totalSupply: 100_100n }).status, "Mismatch");
    assert.equal(assess({ ...agreeing(), ledgerReserve: 99_900n }).status, "Mismatch");
  });

  it("reports a shortfall when the books agree but the statement does not cover supply", () => {
    assert.equal(assess({ ...agreeing(), reportedReserve: 99_999n }).status, "Shortfall");
    assert.equal(assess({ ...agreeing(), reportedReserve: null }).status, "Shortfall");
    assert.equal(assess({ ...agreeing(), reportedReserve: 100_000n }).status, "Balanced");
  });

  it("reports a mismatch before a shortfall", () => {
    assert.equal(assess({ ...agreeing(), ledgerReserve: 0n, reportedReserve: 0n }).status, "Mismatch");
  });

  it("needs no reserve statement while nothing is in issue", () => {
    const outcome = assess({ ledger: [], chain: new Map(), totalSupply: 0n, ledgerReserve: 0n, reportedReserve: null });

    assert.equal(outcome.status, "Balanced");
  });
});
