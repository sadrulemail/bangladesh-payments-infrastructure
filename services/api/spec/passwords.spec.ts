import assert from "node:assert/strict";

import { hashPassphrase, verifyPassphrase } from "../src/auth/passwords";

const PASSPHRASE = "monsoon-ferry-ghat-2026";

describe("Passphrases", function () {
  // Each scrypt derivation takes a noticeable moment by design.
  this.timeout(10_000);

  it("verifies the passphrase a hash was made from, and no other", async () => {
    const stored = await hashPassphrase(PASSPHRASE);

    assert.match(stored, /^scrypt\$32768\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(await verifyPassphrase(PASSPHRASE, stored), true);
    assert.equal(await verifyPassphrase(`${PASSPHRASE}!`, stored), false);
  });

  it("salts every hash", async () => {
    assert.notEqual(await hashPassphrase(PASSPHRASE), await hashPassphrase(PASSPHRASE));
  });

  it("never matches a malformed hash or one with a cost outside the accepted range", async () => {
    const [, , salt, key] = (await hashPassphrase(PASSPHRASE)).split("$");
    const malformed = [
      "",
      "plain",
      `bcrypt$32768$${salt}$${key}`,
      `scrypt$1048576$${salt}$${key}`,
      `scrypt$30000$${salt}$${key}`,
      `scrypt$32768$${salt}$`,
    ];

    for (const stored of malformed) {
      assert.equal(await verifyPassphrase(PASSPHRASE, stored), false, stored);
    }
  });
});
