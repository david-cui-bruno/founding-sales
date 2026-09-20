import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isAdminScope } from '../db/workspaceScope.ts';
import {
  CALLING_WINDOW_FLOOR,
  CALLING_WINDOW_WEEKDAYS,
  evaluateCallingWindow,
  narrowCallingWindow,
  type CallingWindow,
  type CallingWindowDecision,
} from '../src/rules/callingWindow.ts';
import { localParts } from '../src/rules/localClock.ts';
import { acceptPolicy, refusePolicy, type PolicyResult } from './types.ts';

/**
 * The configured calling window (specification 9.2 step 7, 10.1, Appendix D).
 *
 * The floor is in code: `CALLING_WINDOW_FLOOR`, Monday to Friday 08:00 to 20:00 on
 * the *firm's* clock, ported from the old build. A configuration may only narrow it.
 * That rule already exists in `@fss/domain`; this file adds the two things the
 * database has to hold — the current configuration and its history — and the weekday
 * narrowing, which the ported function does not take because the old build had no
 * configurable weekdays.
 *
 * Weekdays are intersected rather than replaced, for the same reason the hours are
 * clamped: a configuration that could add Saturday would be a configuration that can
 * widen the floor, and the floor exists precisely so that a mistaken configuration
 * cannot place a call at an hour nobody meant.
 */

export interface ConfiguredCallingWindow {
  readonly id: string;
  readonly version: number;
  readonly window: CallingWindow;
  /** ISO weekday numbers, 1 = Monday. Always a subset of the floor's Monday to Friday. */
  readonly weekdays: readonly number[];
}

interface WindowRow {
  readonly id: string;
  readonly version: number;
  readonly start_minute: number;
  readonly end_minute: number;
  readonly weekdays: number[];
  readonly [column: string]: unknown;
}

/** The floor as a configuration, for a workspace that has never set one. */
export const FLOOR_CALLING_WINDOW: ConfiguredCallingWindow = Object.freeze({
  id: '',
  version: 0,
  window: CALLING_WINDOW_FLOOR,
  weekdays: CALLING_WINDOW_WEEKDAYS,
});

function narrowWeekdays(configured: readonly number[]): readonly number[] {
  const inside = configured.filter(day => CALLING_WINDOW_WEEKDAYS.includes(day)).sort((a, b) => a - b);
  // A configuration that leaves nothing is the floor itself, exactly as
  // `narrowCallingWindow` treats an empty range.
  return inside.length === 0 ? CALLING_WINDOW_WEEKDAYS : inside;
}

/** The workspace's current window, narrowed to the floor. Never null: the floor is the default. */
export async function currentCallingWindow(context: RepositoryContext): Promise<ConfiguredCallingWindow> {
  const { rows } = await context.db.query<WindowRow>(
    `SELECT id, version, start_minute, end_minute, weekdays
       FROM calling_windows
      WHERE workspace_id = $1 AND superseded_at IS NULL`,
    [context.scope.workspaceId],
  );
  const row = rows[0];
  if (row === undefined) return FLOOR_CALLING_WINDOW;
  return {
    id: row.id,
    version: row.version,
    window: narrowCallingWindow({ startMinute: row.start_minute, endMinute: row.end_minute }),
    weekdays: narrowWeekdays(row.weekdays),
  };
}

export type ConfiguredWindowDecision =
  | (CallingWindowDecision & { readonly allowed: true })
  | (CallingWindowDecision & { readonly allowed: false })
  | {
      readonly allowed: false;
      readonly refusal: 'outside_calling_window';
      readonly localTime: string;
      readonly localDate: string;
      readonly openNow: boolean | null;
      readonly window: CallingWindow;
    };

/**
 * Whether the firm's local clock permits a call under the configured window.
 *
 * The hours go to the ported `evaluateCallingWindow`, which already knows the floor
 * and the Monday-to-Friday rule; the configured weekdays narrow it afterwards. A day
 * the configuration excluded is `outside_calling_window`, the same code the hours
 * refuse with, because from the caller's side there is one answer: not now.
 */
export function evaluateConfiguredCallingWindow(
  at: string,
  zone: string | null,
  configured: ConfiguredCallingWindow,
): ConfiguredWindowDecision {
  const decision = evaluateCallingWindow(at, zone, configured.window);
  if (!decision.allowed) return decision;
  const parts = localParts(at, zone ?? '');
  if (!configured.weekdays.includes(parts.weekday)) {
    return {
      allowed: false,
      refusal: 'outside_calling_window',
      localTime: decision.localTime,
      localDate: decision.localDate,
      openNow: decision.openNow,
      window: decision.window,
    };
  }
  return decision;
}

export interface SetCallingWindowInput {
  readonly startMinute: number;
  readonly endMinute: number;
  readonly weekdays?: readonly number[] | undefined;
}

/**
 * Supersede the current window with a new one.
 *
 * The refusal that matters is `window_not_narrower`: a configuration outside the
 * floor is refused rather than silently clamped, so an admin who typed 07:00 is told
 * the floor is 08:00 instead of discovering later that their configuration did
 * nothing. The clamp in `narrowCallingWindow` stays as the reader's safety net for
 * rows written before this check existed.
 */
export async function setCallingWindow(
  context: RepositoryContext,
  input: SetCallingWindowInput,
): Promise<PolicyResult<ConfiguredCallingWindow>> {
  if (!isAdminScope(context.scope)) return refusePolicy('admin_only');
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('admin_only');

  const startMinute = Math.trunc(input.startMinute);
  const endMinute = Math.trunc(input.endMinute);
  if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute) || endMinute <= startMinute) {
    return refusePolicy('invalid_input');
  }
  if (startMinute < CALLING_WINDOW_FLOOR.startMinute || endMinute > CALLING_WINDOW_FLOOR.endMinute) {
    return refusePolicy('window_not_narrower');
  }
  const weekdays = [...new Set(input.weekdays ?? CALLING_WINDOW_WEEKDAYS)].sort((a, b) => a - b);
  if (weekdays.length === 0 || weekdays.some(day => !CALLING_WINDOW_WEEKDAYS.includes(day))) {
    return refusePolicy('window_not_narrower');
  }

  await context.db.query(
    `UPDATE calling_windows
        SET superseded_at = now(), superseded_by_user_id = $2
      WHERE workspace_id = $1 AND superseded_at IS NULL`,
    [context.scope.workspaceId, actor.userId],
  );
  const { rows } = await context.db.query<WindowRow>(
    `INSERT INTO calling_windows
       (workspace_id, version, start_minute, end_minute, weekdays, created_by_user_id)
     VALUES ($1,
             (SELECT coalesce(max(version), 0) + 1 FROM calling_windows WHERE workspace_id = $1),
             $2, $3, $4::smallint[], $5)
     RETURNING id, version, start_minute, end_minute, weekdays`,
    [context.scope.workspaceId, startMinute, endMinute, weekdays, actor.userId],
  );
  const row = rows[0];
  if (row === undefined) return refusePolicy('invalid_input');
  return acceptPolicy({
    id: row.id,
    version: row.version,
    window: { startMinute: row.start_minute, endMinute: row.end_minute },
    weekdays: row.weekdays,
  });
}
