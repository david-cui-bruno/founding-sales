/**
 * The write watermark (lane G11; specification 2 "Data carry", 17, Appendix G 20).
 *
 * "Cutover establishes a write watermark, imports and reconciles the final delta,
 * verifies counts and hashes, then makes the old stack read-only."
 *
 * The watermark is a fact about the world — the instant David disabled the old
 * worker's EventBridge schedule — and nothing in this repository can observe it. So
 * it is a file David writes by hand as step two of the runbook, and the export
 * refuses to run without it. There is no default, no `--assume-stopped` and no
 * environment variable: a carry with no watermark is a carry that cannot say what it
 * was allowed to read, and every later parity number would be meaningless.
 *
 * The flag names the rule as well as the instant, because "I disabled the schedule"
 * and "I disabled *that* schedule" are different claims and only the second one can
 * be checked against the console afterwards.
 */

export const CARRY_WATERMARK_SCHEMA = 'fss.carry.watermark.v1';

export interface CarryWatermark {
  readonly schema: typeof CARRY_WATERMARK_SCHEMA;
  /** ISO-8601 UTC. The instant the old worker's schedule stopped firing. */
  readonly disabledAt: string;
  /** The EventBridge rule that was disabled. A public identifier, never an ARN. */
  readonly scheduleRuleName: string;
  /** Who recorded it. A role word — `operator` — never a person's contact details. */
  readonly recordedBy: string;
}

export type WatermarkRefusal =
  | 'watermark_absent'
  | 'watermark_unreadable'
  | 'watermark_schema_unknown'
  | 'watermark_instant_invalid'
  | 'watermark_schedule_unnamed'
  | 'watermark_in_future';

export type WatermarkResult =
  | { readonly ok: true; readonly value: CarryWatermark }
  | { readonly ok: false; readonly reason: WatermarkRefusal };

/**
 * Read the flag file's contents. Pure: the CLI does the reading, so a missing file
 * and an unreadable one are the same two values here and both are tested.
 *
 * `now` is a parameter for the same reason `databaseNow` is one in G4: a rule that
 * reads the clock itself cannot be tested at its boundary.
 */
export function readWatermark(source: string | null, now: Date): WatermarkResult {
  if (source === null || source.trim().length === 0) return { ok: false, reason: 'watermark_absent' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, reason: 'watermark_unreadable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'watermark_unreadable' };
  }
  const flag = parsed as Record<string, unknown>;
  if (flag['schema'] !== CARRY_WATERMARK_SCHEMA) return { ok: false, reason: 'watermark_schema_unknown' };

  const disabledAt = flag['disabledAt'];
  if (typeof disabledAt !== 'string' || disabledAt.trim().length === 0) {
    return { ok: false, reason: 'watermark_instant_invalid' };
  }
  const instant = Date.parse(disabledAt);
  if (Number.isNaN(instant)) return { ok: false, reason: 'watermark_instant_invalid' };

  const rule = flag['scheduleRuleName'];
  if (typeof rule !== 'string' || rule.trim().length === 0) return { ok: false, reason: 'watermark_schedule_unnamed' };

  // A watermark in the future would let the export carry writes the old worker had
  // not made yet, which is the one thing the watermark exists to prevent.
  if (instant > now.getTime()) return { ok: false, reason: 'watermark_in_future' };

  const recordedBy = flag['recordedBy'];
  return {
    ok: true,
    value: {
      schema: CARRY_WATERMARK_SCHEMA,
      disabledAt: new Date(instant).toISOString(),
      scheduleRuleName: rule.trim(),
      recordedBy: typeof recordedBy === 'string' && recordedBy.trim().length > 0 ? recordedBy.trim() : 'unrecorded',
    },
  };
}

/** Whether a record the old table holds was written after the schedule stopped. */
export function isAfterWatermark(recordedAt: string, watermarkAt: string): boolean {
  return Date.parse(recordedAt) > Date.parse(watermarkAt);
}
