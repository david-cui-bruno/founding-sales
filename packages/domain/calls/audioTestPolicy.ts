import type { CallSessionRefusalCode, DialRefusalCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { listApplicableHolds } from '../policy/holds.ts';
import { workspaceBusinessZone } from '../research/ledger.ts';
import { readCallingProvider } from '../settings/integrations.ts';
import { firstSuppressed } from '../suppression/effective.ts';
import { isoMicroseconds } from './cadence.ts';
import {USABLE_CALLING_IDENTITY_SQL} from '../dial/identities.ts';

export type AudioTestRefusal = DialRefusalCode | CallSessionRefusalCode;
export type AudioTestClearance = { readonly ok: true; readonly at: string } | { readonly ok: false; readonly reason: AudioTestRefusal };
export const AUDIO_TEST_SECONDS = 60;

/** Live database time, read after waits. Never accepts a policy-test clock. */
export async function audioTestClock(context: RepositoryContext): Promise<string> {
  const row = (await context.db.query<{ at: string }>(`SELECT ${isoMicroseconds('clock_timestamp()')} AS at`)).rows[0];
  if (!row) throw new Error('the database did not answer with its clock');
  return row.at;
}

/** After the shared send gate, before session rows: concurrent sessions cannot share an allowance. */
export async function lockAudioTestAllowance(context: RepositoryContext): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${context.scope.workspaceId}:audio_test`,
  ]);
}

/** Explicit personal tests retain endpoint stops, without changing business eligibility facts. */
export async function readAudioTestAccess(
  context: RepositoryContext,
  input: { readonly deviceId: string; readonly callingIdentityId: string; readonly e164: string; readonly configuredCallerIdE164?: string },
): Promise<{ readonly ok: true; readonly callerIdE164: string } | { readonly ok: false; readonly reason: AudioTestRefusal }> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || actor.role !== 'admin') return { ok: false, reason: 'audio_test_admin_only' };
  const member = (await context.db.query<{ role: string; status: string }>(
    'SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',
    [context.scope.workspaceId, actor.userId],
  )).rows[0];
  if (member?.status !== 'active' || member.role !== 'admin') return { ok: false, reason: 'audio_test_admin_only' };
  const device = (await context.db.query(
    "SELECT id FROM devices WHERE workspace_id=$1 AND id=$2 AND user_id=$3 AND status='active' FOR SHARE",
    [context.scope.workspaceId, input.deviceId, actor.userId],
  )).rows[0];
  if (!device) return { ok: false, reason: 'ticket_wrong_device' };
  const identity = (await context.db.query<{ owner_user_id: string | null; usable: boolean; e164: string }>(
    `SELECT owner_user_id,${USABLE_CALLING_IDENTITY_SQL} AS usable,e164 FROM calling_identities WHERE workspace_id=$1 AND id=$2 FOR SHARE`,
    [context.scope.workspaceId, input.callingIdentityId],
  )).rows[0];
  if (!identity) return { ok: false, reason: 'identity_missing' };
  if (identity.owner_user_id === null) return { ok: false, reason: 'identity_shared_line_disabled' };
  if (identity.owner_user_id !== actor.userId) return { ok: false, reason: 'identity_not_owned' };
  if (!identity.usable) return { ok: false, reason: 'identity_disabled' };
  if (input.configuredCallerIdE164 !== undefined && identity.e164 !== input.configuredCallerIdE164) return { ok: false, reason: 'caller_id_mismatch' };
  if (await readCallingProvider(context) !== 'twilio') return { ok: false, reason: 'scoped_pause' };
  if (await firstSuppressed(context, [{ scope: 'handle', canonicalKey: input.e164 }], 'phone')) return { ok: false, reason: 'handle_suppressed' };
  const match = await context.db.query(`SELECT 1 FROM national_registry_endpoint_scrubs
    WHERE workspace_id=$1 AND e164=$2 AND result='match' LIMIT 1`, [context.scope.workspaceId, input.e164]);
  if (match.rows.length) return { ok: false, reason: 'dnc_registry_match' };
  const holds = await listApplicableHolds(context, { actionKind: 'dial_authorization', ownerUserId: actor.userId, channel: 'call' });
  if (holds[0]) return { ok: false, reason: holds[0].reasonCode as DialRefusalCode };
  return { ok: true, callerIdE164: identity.e164 };
}

/** Count actual consumed tests, including uncertain ones; expiry never refunds a placed attempt. */
export async function readAudioTestAllowance(
  context: RepositoryContext,
  at: string,
  sessionId?: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: AudioTestRefusal }> {
  const zone = await workspaceBusinessZone(context);
  const facts = (await context.db.query<{ today: number; recent: number; active: boolean }>(
    `SELECT count(*) FILTER (WHERE s.consumed_at IS NOT NULL
              AND (s.consumed_at AT TIME ZONE $3)::date=($2::timestamptz AT TIME ZONE $3)::date)::int AS today,
            count(*) FILTER (WHERE s.consumed_at>$2::timestamptz-INTERVAL '14 days')::int AS recent,
            COALESCE(bool_or((s.consumed_at IS NULL AND s.expires_at>$2::timestamptz)
              OR (s.consumed_at IS NOT NULL AND (s.status IN ('authorized','ringing','in_progress')
                OR r.state IN ('reserved','calling')))),false) AS active
       FROM call_sessions s JOIN provider_reservations r ON r.workspace_id=s.workspace_id AND r.id=s.reservation_id
      WHERE s.workspace_id=$1 AND s.purpose='audio_test'
        AND ($4::uuid IS NULL OR s.id<>$4)`,
    [context.scope.workspaceId, at, zone, sessionId ?? null],
  )).rows[0];
  if (!facts) throw new Error('the audio test allowance read returned no row');
  if (facts.active) return { ok: false, reason: 'audio_test_active' };
  if (Number(facts.today) >= 1) return { ok: false, reason: 'audio_test_today' };
  if (Number(facts.recent) >= 4) return { ok: false, reason: 'audio_test_limit' };
  return { ok: true };
}
