import type { Queryable } from '../db/queryable.ts';

/**
 * The release drain (slice A4, C2B milestone): a switch an operator turns on before a
 * schema release stops production, so that nothing new starts in the gap between "the
 * system is idle" and "the services are stopped".
 *
 * **Where it lives.** In `audit_events`, which is append-only and already has a
 * place for an operations write that names who did it. `workspace_settings` would be the
 * natural home, but its key set is a closed CHECK (migration 0019) and a new key is a
 * migration; `heartbeats` has a closed component list and is read by the alarms. So the
 * drain is two actions, `release.drain_on` (whose `detail.until` is the instant it
 * lapses) and `release.drain_off`, and the state is whichever was written last.
 * Nothing here reads or writes `sending_enabled`.
 *
 * **It lapses by itself.** A drain that an operator forgets to turn off, or that a
 * failed release never gets to, ends at `until` (default 20 minutes, never more than
 * 60), so the worst case of a stuck switch is a bounded delay, not a locked-out product.
 *
 * `releaseDrainActive(db)` is what the API asks before it accepts a new call session
 * (slice C1 wires the refusal when call sessions exist).
 */

export const RELEASE_DRAIN_ON_ACTION = 'release.drain_on';
export const RELEASE_DRAIN_OFF_ACTION = 'release.drain_off';
export const RELEASE_DRAIN_DEFAULT_MINUTES = 20;
export const RELEASE_DRAIN_MAX_MINUTES = 60;

/**
 * Bounds the read: a drain lasts at most an hour, so nothing older than this can be the
 * deciding row. Keeps the read off the whole table.
 */
const LOOKBACK = '2 hours';

export interface ReleaseDrainState {
  readonly active: boolean;
  /** When the last `on` lapses or lapsed; null when the last action is `off` or there is none. */
  readonly until: string | null;
  readonly lastAction: 'on' | 'off' | null;
}

const asInstant = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
};

export async function readReleaseDrain(db: Queryable): Promise<ReleaseDrainState> {
  const { rows } = await db.query<{ action: string; until: Date | string | null; active: boolean | null }>(
    `SELECT action,
            (detail->>'until')::timestamptz AS until,
            (action = $1 AND (detail->>'until')::timestamptz > now()) AS active
       FROM audit_events
      WHERE action IN ($1, $2)
        AND subject_kind = 'release' AND subject_id = 'drain'
        AND occurred_at > now() - interval '${LOOKBACK}'
      ORDER BY occurred_at DESC, (action = $2) DESC
      LIMIT 1`,
    [RELEASE_DRAIN_ON_ACTION, RELEASE_DRAIN_OFF_ACTION],
  );
  const row = rows[0];
  if (row === undefined) return { active: false, until: null, lastAction: null };
  const on = row.action === RELEASE_DRAIN_ON_ACTION;
  return { active: on && row.active === true, until: on ? asInstant(row.until) : null, lastAction: on ? 'on' : 'off' };
}

/** True while a release drain is in force: the API refuses new call sessions while it is. */
export async function releaseDrainActive(db: Queryable): Promise<boolean> {
  return (await readReleaseDrain(db)).active;
}

export type SetReleaseDrainResult =
  | { readonly ok: true; readonly state: ReleaseDrainState; readonly minutes: number | null; readonly capped: boolean; readonly workspaces: number }
  | { readonly ok: false; readonly reason: 'minutes_invalid' | 'no_workspace'; readonly detail: string };

export interface SetReleaseDrainInput {
  readonly on: boolean;
  /** Only for `on`. Default 20; above 60 is capped at 60; below one or not whole is refused. */
  readonly minutes?: number | undefined;
  /** Who and what, recorded in the audit row. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * Turn the drain on or off. The caller owns the transaction. One audit row per
 * workspace (the audit table is workspace-scoped and the drain is database-wide), all
 * with the same instant, and the read takes the newest whichever workspace wrote it.
 */
export async function setReleaseDrain(db: Queryable, input: SetReleaseDrainInput): Promise<SetReleaseDrainResult> {
  let minutes: number | null = null;
  let capped = false;
  if (input.on) {
    const asked = input.minutes ?? RELEASE_DRAIN_DEFAULT_MINUTES;
    if (!Number.isInteger(asked) || asked < 1) {
      return { ok: false, reason: 'minutes_invalid', detail: `--minutes takes a whole number of minutes from 1 to ${String(RELEASE_DRAIN_MAX_MINUTES)}` };
    }
    capped = asked > RELEASE_DRAIN_MAX_MINUTES;
    minutes = Math.min(asked, RELEASE_DRAIN_MAX_MINUTES);
  }
  const written = await db.query<{ until: Date | string | null }>(
    `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
     SELECT id, 'system', NULL, $1, 'release', 'drain',
            CASE WHEN $2::int IS NULL
                 THEN $3::jsonb
                 ELSE $3::jsonb || jsonb_build_object('minutes', $2::int, 'until', to_char(
                        (now() + make_interval(mins => $2::int)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            END
       FROM workspaces
     RETURNING detail->>'until' AS until`,
    [input.on ? RELEASE_DRAIN_ON_ACTION : RELEASE_DRAIN_OFF_ACTION, minutes, JSON.stringify(input.detail)],
  );
  if (written.rows.length === 0) {
    return { ok: false, reason: 'no_workspace', detail: 'the database holds no workspace to record the drain against' };
  }
  const state = await readReleaseDrain(db);
  return { ok: true, state, minutes, capped, workspaces: written.rows.length };
}
