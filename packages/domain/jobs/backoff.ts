/**
 * Bounded exponential backoff (specification 13.2: "Retryable failures use bounded
 * exponential backoff").
 *
 * Pure, and deterministic unless the caller supplies a jitter source. The default
 * ladder from a first failure is 30 s, 60 s, 120 s, 240 s … capped at fifteen
 * minutes, so a job that is failing because a provider is down retries four times in
 * the first eight minutes and then stops hammering it.
 */

export interface BackoffPolicy {
  readonly baseSeconds: number;
  readonly factor: number;
  readonly maximumSeconds: number;
  /** Fraction of the delay that may be added, 0 for none. Spreads a thundering herd. */
  readonly jitterFraction: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({
  baseSeconds: 30,
  factor: 2,
  maximumSeconds: 15 * 60,
  jitterFraction: 0.2,
});

/**
 * How long to wait before attempt `attempt + 1`, in seconds.
 *
 * `attempt` is the number of attempts already made, so the first failure passes 1.
 * `random` defaults to a fixed 0, which makes the ladder reproducible in a test; the
 * runner passes `Math.random`.
 */
export function backoffSeconds(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF, random: () => number = () => 0): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt counts from 1');
  const exponent = Math.min(attempt - 1, 32);
  const raw = policy.baseSeconds * policy.factor ** exponent;
  const capped = Math.min(raw, policy.maximumSeconds);
  const jitter = capped * policy.jitterFraction * random();
  return Math.round(capped + jitter);
}

/** Whether this failure exhausts the job (specification 13.2: "Exhausted jobs become dead"). */
export function isExhausted(attempt: number, maxAttempts: number): boolean {
  return attempt >= maxAttempts;
}
