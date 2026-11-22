/** Keys tracked at most. Past this, expired keys are dropped so the map cannot grow without bound. */
const MAX_TRACKED_KEYS = 10_000;

interface Failures {
  count: number;
  since: number;
}

/**
 * Failed sign-ins per key, for instance client address and username. Once a key reaches `limit` failures
 * inside the window it is refused until the window has passed, which makes guessing a passphrase slow.
 *
 * The state lives in the memory of one API process; a deployment that runs several instances keeps it in
 * a store they share.
 */
export class SignInThrottle {
  private readonly failures = new Map<string, Failures>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until `key` may try again; zero when it may try now. */
  retryAfter(key: string): number {
    const entry = this.current(key);
    return entry && entry.count >= this.limit ? entry.since + this.windowMs - this.now() : 0;
  }

  recordFailure(key: string): void {
    const entry = this.current(key);
    if (entry) entry.count += 1;
    else this.failures.set(key, { count: 1, since: this.now() });
    if (this.failures.size > MAX_TRACKED_KEYS) this.forgetExpired();
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  /** Failures of `key` inside the current window; an expired entry is dropped. */
  private current(key: string): Failures | undefined {
    const entry = this.failures.get(key);
    if (entry && this.now() - entry.since >= this.windowMs) {
      this.failures.delete(key);
      return undefined;
    }
    return entry;
  }

  private forgetExpired(): void {
    for (const key of [...this.failures.keys()]) this.current(key);
  }
}
