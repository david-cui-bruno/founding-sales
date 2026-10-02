import {
  RECAP_MAX_QUOTES,
  RECAP_RECURRING_AT,
  RECAP_SMALL_SAMPLE_BELOW,
  callAnalysisResultSchema,
  type CallAnalysisResult,
  type CallRecapResponse,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * The daily recap (slice 3a, DESIGN-S3A §2.10): `GET /calls/recap`, a read with no table, no
 * job and no model call behind it.
 *
 * It takes **each call's latest completed model analysis** for the business date — a call
 * reanalysed three times counts once — and reports, from those stored results only:
 *
 *   * how many calls there were (n) and whether that is a small sample;
 *   * each objection category as "in k of n calls", with up to three verbatim quotes from
 *     different calls, and `recurring` once it appears in two calls or more;
 *   * one coaching observation: the newest one any of the calls produced, which the analysis
 *     wrote against transcript lines, or none.
 *
 * A salesperson is read their own firms' calls, an administrator the workspace's, as
 * `readCallsPlacedToday` does.
 */

export interface RecapSource {
  readonly callSessionId: string;
  readonly completedAt: string;
  readonly result: CallAnalysisResult;
}

/** The pure part: grouping, counting and the labels' inputs. */
export function buildRecap(businessDate: string, businessTimeZone: string, sources: readonly RecapSource[]): CallRecapResponse {
  const byCategory = new Map<string, { calls: Set<string>; quotes: { quote: string; callSessionId: string }[] }>();
  for (const source of sources) {
    for (const objection of source.result.objections) {
      const entry = byCategory.get(objection.category) ?? { calls: new Set<string>(), quotes: [] };
      // One call raising an objection twice is still one call, and shows one quote.
      if (!entry.calls.has(source.callSessionId) && entry.quotes.length < RECAP_MAX_QUOTES) {
        entry.quotes.push({ quote: objection.ref.quote, callSessionId: source.callSessionId });
      }
      entry.calls.add(source.callSessionId);
      byCategory.set(objection.category, entry);
    }
  }
  const objections = [...byCategory.entries()]
    .map(([category, entry]) => ({
      category: category as CallRecapResponse['objections'][number]['category'],
      calls: entry.calls.size,
      recurring: entry.calls.size >= RECAP_RECURRING_AT,
      quotes: entry.quotes,
    }))
    .sort((left, right) => right.calls - left.calls || left.category.localeCompare(right.category));

  const newest = [...sources]
    .filter(source => source.result.coaching !== null)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
  const coaching =
    newest?.result.coaching == null ? null : { observation: newest.result.coaching.observation, callSessionId: newest.callSessionId };

  return {
    businessDate,
    businessTimeZone,
    callsAnalysed: sources.length,
    smallSample: sources.length < RECAP_SMALL_SAMPLE_BELOW,
    objections,
    coaching,
  };
}

export async function readDailyRecap(
  context: RepositoryContext,
  options: { readonly date?: string | undefined } = {},
): Promise<CallRecapResponse> {
  const actor = context.scope.actor;
  const assignedUserId = actor.kind === 'user' && actor.role !== 'admin' ? actor.userId : null;
  const { rows: days } = await context.db.query<{ zone: string; today: string }>(
    `SELECT business_time_zone AS zone, ((now() AT TIME ZONE business_time_zone)::date)::text AS today
       FROM workspaces WHERE id = $1`,
    [context.scope.workspaceId],
  );
  const day = days[0];
  if (day === undefined) throw new Error('the workspace has no business time zone');
  const date = options.date ?? day.today;

  const { rows } = await context.db.query<{ session_id: string; completed_at: Date; result: unknown }>(
    `SELECT DISTINCT ON (a.call_session_id) a.call_session_id AS session_id, a.completed_at, a.result
       FROM call_analyses a
       JOIN call_sessions s ON s.workspace_id = a.workspace_id AND s.id = a.call_session_id
       JOIN firms f ON f.workspace_id = s.workspace_id AND f.id = s.firm_id
      WHERE a.workspace_id = $1 AND a.origin = 'model' AND a.state = 'completed' AND a.result IS NOT NULL
        AND (coalesce(s.answered_at, s.started_at, s.created_at) AT TIME ZONE $2)::date = $3::date
        AND ($4::uuid IS NULL OR f.assigned_user_id = $4::uuid)
      ORDER BY a.call_session_id, a.version DESC`,
    [context.scope.workspaceId, day.zone, date, assignedUserId],
  );
  return buildRecap(
    date,
    day.zone,
    rows.map(row => ({
      callSessionId: row.session_id,
      completedAt: row.completed_at.toISOString(),
      result: callAnalysisResultSchema.parse(row.result),
    })),
  );
}
