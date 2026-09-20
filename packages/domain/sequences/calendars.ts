import { isAdminScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { EMPTY_HOLIDAY_CALENDAR, type WorkspaceHolidayCalendar } from '../src/index.ts';
import { acceptSequence, refuseSequence, type SequenceResult } from './types.ts';

/**
 * The workspace holiday calendar (specification 11.2, Appendix D).
 *
 * "A business-day delay skips weekends and configured workspace holidays." The dates
 * are configuration; the rule that reads them is `addBusinessDays` in
 * `packages/domain/src/rules/businessDays.ts`, and this is only the storage.
 *
 * Versioned rather than edited. Every due instant this lane stores names the calendar
 * that produced it inside its `rule_version`, and an edit in place would make a
 * stored instant claim a calendar it was never computed from. Superseding writes the
 * new row and stamps the old one in the same transaction, and the partial unique
 * index refuses two current rows however the two statements interleave.
 *
 * A workspace with no calendar gets `EMPTY_HOLIDAY_CALENDAR`, not an error. Weekends
 * are in the rule rather than in the table, so an empty calendar is a correct
 * calendar: it means Callie observes no holidays, which is a true statement about a
 * workspace nobody has configured.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

interface CalendarDbRow {
  readonly version: string;
  readonly dates: (Date | string)[];
  readonly [column: string]: unknown;
}

const asLocalDate = (value: Date | string): string =>
  typeof value === 'string' ? value : value.toISOString().slice(0, 10);

/** The workspace's current calendar, or the empty one. */
export async function currentHolidayCalendar(
  context: RepositoryContext,
): Promise<WorkspaceHolidayCalendar> {
  const { rows } = await context.db.query<CalendarDbRow>(
    `SELECT version, dates FROM workspace_holiday_calendars
      WHERE workspace_id = $1 AND superseded_at IS NULL`,
    [context.scope.workspaceId],
  );
  const row = rows[0];
  if (row === undefined) return EMPTY_HOLIDAY_CALENDAR;
  return { version: row.version, dates: row.dates.map(asLocalDate).sort() };
}

/**
 * A calendar by version, for an enrollment that froze one.
 *
 * An enrollment records the version it started under, so a later supersession does
 * not re-time work that is halfway through. A version nobody can find any more is the
 * empty calendar rather than a throw: the alternative is an enrollment that cannot be
 * read at all because a configuration row was deleted.
 */
export async function holidayCalendarByVersion(
  context: RepositoryContext,
  version: string,
): Promise<WorkspaceHolidayCalendar> {
  const { rows } = await context.db.query<CalendarDbRow>(
    `SELECT version, dates FROM workspace_holiday_calendars WHERE workspace_id = $1 AND version = $2`,
    [context.scope.workspaceId, version],
  );
  const row = rows[0];
  if (row === undefined) return { version, dates: [] };
  return { version: row.version, dates: row.dates.map(asLocalDate).sort() };
}

export interface RecordHolidayCalendarInput {
  readonly version: string;
  /** Local calendar dates, `YYYY-MM-DD`. */
  readonly dates: readonly string[];
}

/**
 * Supersede the current calendar with a new version. Admin only (10.1: "Admins
 * maintain versioned state postures, call windows, approved template versions ...").
 */
export async function recordHolidayCalendar(
  context: RepositoryContext,
  input: RecordHolidayCalendarInput,
): Promise<SequenceResult<WorkspaceHolidayCalendar>> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');
  if (!VERSION_PATTERN.test(input.version)) return refuseSequence('invalid_input');
  if (input.dates.some(date => !DATE_PATTERN.test(date))) return refuseSequence('invalid_input');
  if (context.scope.actor.kind !== 'user') return refuseSequence('admin_only');

  const taken = await context.db.query(
    'SELECT 1 FROM workspace_holiday_calendars WHERE workspace_id = $1 AND version = $2',
    [context.scope.workspaceId, input.version],
  );
  if (taken.rows.length > 0) return refuseSequence('calendar_version_taken');

  await context.db.query(
    `UPDATE workspace_holiday_calendars SET superseded_at = now()
      WHERE workspace_id = $1 AND superseded_at IS NULL`,
    [context.scope.workspaceId],
  );
  await context.db.query(
    `INSERT INTO workspace_holiday_calendars (workspace_id, version, dates, created_by_user_id)
     VALUES ($1, $2, $3::date[], $4)`,
    [context.scope.workspaceId, input.version, [...input.dates], context.scope.actor.userId],
  );
  return acceptSequence({ version: input.version, dates: [...input.dates].sort() });
}
