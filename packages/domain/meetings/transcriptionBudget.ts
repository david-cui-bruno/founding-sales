import { meetingTranscriptionSettingSchema, DEFAULT_MEETING_TRANSCRIPTION } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSetting } from '../settings/store.ts';
import { workspaceBusinessZone } from '../research/ledger.ts';
import { endOfLocalDay, localDate } from '../src/rules/localClock.ts';
/** Exact decoded seconds, including silence; once-rounded cents per file and attempt. */
export function meetingTranscriptionCents(durationMs: number, unitPriceMicros = 6000): number {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 14400000 || !Number.isSafeInteger(unitPriceMicros) || unitPriceMicros < 0 || unitPriceMicros > 10000000) throw new Error('invalid_transcription_price');
  return Math.ceil(Math.max(15, Math.ceil(durationMs / 1000)) * unitPriceMicros / 600000);
}
export async function meetingFunding(context: RepositoryContext, at: string, accountId: string) {
  const stored = await readSetting(context, 'meeting_transcription');
  const parsed = meetingTranscriptionSettingSchema.safeParse(stored.value);
  const setting = parsed.success ? parsed.data : DEFAULT_MEETING_TRANSCRIPTION;
  const coverage = setting.creditCoverage;
  const reason = !setting.enabled ? 'disabled' : setting.dailyCeilingCents === 0 ? 'zero_allowance'
    : coverage === null || coverage.status !== 'verified' || coverage.accountId !== accountId
      || Date.parse(coverage.verifiedAt) > Date.parse(at) || Date.parse(coverage.validUntil) <= Date.parse(at)
      ? 'funding_unverified' : null;
  return { setting, version: stored.version, reason };
}
export async function lockMeetingBudget(context: RepositoryContext): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${context.scope.workspaceId}:meeting_transcription_budget`]);
}
export async function meetingBudgetDay(context: RepositoryContext, at: string) {
  const zone = await workspaceBusinessZone(context);
  return { zone, date: localDate(at, zone), next: new Date(Date.parse(endOfLocalDay(at, zone)) + 1).toISOString() };
}
export async function meetingSpent(context: RepositoryContext, date: string): Promise<number> {
  return Number((await context.db.query<{ cents: string }>(`SELECT COALESCE(sum(CASE WHEN state IN ('reserved','calling') THEN cents ELSE settled_cents END),0)::text AS cents
    FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='meeting_transcription' AND business_date=$2::date`, [context.scope.workspaceId, date])).rows[0]?.cents ?? 0);
}
