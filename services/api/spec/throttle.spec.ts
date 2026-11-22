import assert from "node:assert/strict";

import { SignInThrottle } from "../src/auth/throttle";

const MINUTE = 60_000;
const KEY = "127.0.0.1|admin.surma";

/** A throttle of three attempts per ten minutes, on a clock the spec moves by hand. */
function throttleWithClock() {
  let now = 1_000_000;
  const throttle = new SignInThrottle(3, 10 * MINUTE, () => now);
  return {
    throttle,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Sign-in throttle", () => {
  it("lets a key try until it reaches the limit, then holds it back for the rest of the window", () => {
    const { throttle, advance } = throttleWithClock();
    throttle.recordFailure(KEY);
    throttle.recordFailure(KEY);
    assert.equal(throttle.retryAfter(KEY), 0);

    advance(4 * MINUTE);
    throttle.recordFailure(KEY);
    assert.equal(throttle.retryAfter(KEY), 6 * MINUTE);
  });

  it("lets the key try again once the window has passed", () => {
    const { throttle, advance } = throttleWithClock();
    for (let attempt = 0; attempt < 3; attempt += 1) throttle.recordFailure(KEY);

    advance(10 * MINUTE);
    assert.equal(throttle.retryAfter(KEY), 0);
    throttle.recordFailure(KEY);
    assert.equal(throttle.retryAfter(KEY), 0);
  });

  it("forgets the failures of a key that signs in", () => {
    const { throttle } = throttleWithClock();
    throttle.recordFailure(KEY);
    throttle.recordFailure(KEY);
    throttle.recordSuccess(KEY);
    throttle.recordFailure(KEY);
    throttle.recordFailure(KEY);

    assert.equal(throttle.retryAfter(KEY), 0);
  });

  it("counts every key on its own", () => {
    const { throttle } = throttleWithClock();
    for (let attempt = 0; attempt < 3; attempt += 1) throttle.recordFailure(KEY);

    assert.ok(throttle.retryAfter(KEY) > 0);
    assert.equal(throttle.retryAfter("127.0.0.1|admin.sangu"), 0);
  });
});
