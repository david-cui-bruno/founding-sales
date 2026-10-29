import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import type { Queryable, QueryResultRowLike } from '../../db/queryable.ts';

export const ids = {
  workspace: '00000000-0000-4000-8000-000000000001', user: '00000000-0000-4000-8000-000000000002',
  device: '00000000-0000-4000-8000-000000000003', identity: '00000000-0000-4000-8000-000000000004',
  command: '00000000-0000-4000-8000-000000000005', session: '00000000-0000-4000-8000-000000000006',
  request: '00000000-0000-4000-8000-000000000007', reservation: '00000000-0000-4000-8000-000000000008',
};
export const destination = '+12025550199', caller = '+12025550198';
export const createInput = { e164: destination, callingIdentityId: ids.identity, deviceId: ids.device, commandId: ids.command, configuredCallerIdE164: caller };
export const consumeInput = { workspaceId: ids.workspace, sessionId: ids.session, callSid: `CA${'1'.repeat(32)}`, identity: `client:${ids.user}`, configuredCallerIdE164: caller };

/** A deliberately small SQL double. Unexpected business/AI writes throw; no providers or database are started. */
export function audioTestWorld() {
  const trace: { sql: string; values: readonly unknown[] }[] = [];
  const state = {
    now: '2026-10-28T16:00:00.000Z', expires: '2026-10-28T16:01:00.000Z', zone: 'America/New_York',
    role: 'admin', memberStatus: 'active', deviceActive: true, identityOwner: ids.user as string | null,
    identityEnabled: true, identityDisabledAt: null as Date | null, identityE164: caller, provider: 'twilio',
    suppressed: false, registryMatch: false, knownPersonal: false, hold: false, dailyCeiling: 100, monthlyCeiling: 2500,
    unitPriceMicros: 25000, maxMinutes: 10, spent: 0, monthlySpent: 0, today: 0, recent: 0, active: false,
    session: true, sessionId: ids.session as string, requestId: ids.request as string, request: true,
    e164: destination as string | null, erasedAt: null as Date | null, purpose: 'audio_test',
    consumed: false, consumedAt: null as Date | null, status: 'authorized', providerStatus: null as string | null,
    answeredAt: null as Date | null, duration: null as number | null, billed: null as number | null,
    recordingPath: null as string | null, recordingSeconds: null as number | null,
    reservation: true, reservationState: 'reserved', cents: 3, settledCents: 0, businessDate: '2026-10-28',
    reservationMaxMinutes: 1, ledgerCents: 0, receiptStatus: 'accepted', receipt: true, payloadHash: 'a'.repeat(64),
  };
  const hooks: { beforeQuery?: (sql: string) => void } = {};
  const snapshots = new Map<string, typeof state>();
  const rowSession = () => ({ id: state.sessionId, workspace_id: ids.workspace, ticket_id: null, firm_id: null,
    purpose: state.purpose, contact_id: null, actor_user_id: ids.user, reservation_id: ids.reservation,
    expires_at: new Date(state.expires), consumed_at: state.consumedAt, expired: state.now >= state.expires,
    status: state.status, provider_status: state.providerStatus, answered_at: state.answeredAt,
    duration_seconds: state.duration, billed_price_cents: state.billed, call_log_id: null,
    recording_path: state.recordingPath, recording_duration_seconds: state.recordingSeconds,
  });
  const rowRequest = () => ({ device_id: ids.device, calling_identity_id: ids.identity, e164: state.e164,
    erased_at: state.erasedAt, request_expires_at: new Date(state.expires), ...rowSession() });
  const rowReservation = () => ({ id: ids.reservation, state: state.reservationState, provider_key: 'twilio.voice',
    business_date: state.businessDate, business_time_zone: state.zone, cents: state.cents,
    unit_price_micros: state.unitPriceMicros, max_units: state.reservationMaxMinutes, settled_cents: state.settledCents });
  const openCents = () => state.reservation && ['reserved', 'calling'].includes(state.reservationState) ? state.cents : 0;
  const db: Queryable = { async query<Row extends QueryResultRowLike>(original: string, args?: readonly unknown[]) {
    const sql = original.replace(/\s+/gu, ' ').trim(), values = args ?? [];
    trace.push({ sql, values }); hooks.beforeQuery?.(sql);
    let rows: unknown[] = [], count: number | undefined;
    if (sql.startsWith('SELECT pg_')) { /* transaction locks */ }
    else if (sql.startsWith('SAVEPOINT ')) snapshots.set(sql.slice(10), structuredClone(state));
    else if (sql.startsWith('ROLLBACK TO SAVEPOINT ')) {
      const snapshot = snapshots.get(sql.slice(22));
      if (!snapshot) throw new Error('unknown fake savepoint');
      Object.assign(state, snapshot);
    } else if (sql.startsWith('SELECT to_char') || sql === 'SELECT clock_timestamp()::text AS at') rows = [{ at: state.now }];
    else if (sql === 'SELECT clock_timestamp() AS at') rows = [{ at: new Date(state.now) }];
    else if (sql.includes('FROM workspace_memberships')) rows = [{ role: state.role, status: state.memberStatus, user_id: ids.user }];
    else if (sql.includes('FROM devices')) rows = state.deviceActive ? [{ id: ids.device }] : [];
    else if (sql.includes('FROM calling_identities')) rows = [{ owner_user_id: state.identityOwner, usable: state.identityEnabled && state.identityDisabledAt === null, e164: state.identityE164 }];
    else if (sql.includes('FROM phone_routes')) rows = [{ known_personal_cell_at: state.knownPersonal ? new Date(state.now) : null }];
    else if (sql.includes('FROM workspace_settings')) {
      const value = values[1] === 'calling_provider' ? { provider: state.provider }
        : values[1] === 'telephony_budget' ? { dailyCeilingCents: state.dailyCeiling, maxMinutesPerCall: state.maxMinutes, unitPriceMicros: state.unitPriceMicros }
          : values[1] === 'monthly_cash_ceiling_cents' ? { cents: state.monthlyCeiling }
            : values[1] === 'call_transcription' ? { enabled: true, dailyCeilingCents: 100, unitPriceMicros: 1000 } : undefined;
      if (value === undefined) throw new Error('unexpected setting in fake');
      rows = [{ value, version: 1 }];
    } else if (sql.includes('FROM workspaces')) rows = [{ business_time_zone: state.zone }];
    else if (sql.includes('FROM effective_suppressions')) rows = state.suppressed ? [{ event_id: ids.command, scope: 'handle', canonical_key: destination,
      canonicalizer_version: 'v1', source: 'prospect_do_not_call', actor_user_id: null, recorded_at: new Date(state.now), channel: 'phone' }] : [];
    else if (sql.includes('FROM national_registry_endpoint_scrubs')) rows = state.registryMatch ? [{ found: 1 }] : [];
    else if (sql.includes('FROM active_holds')) rows = state.hold ? [{ id: ids.command, scope_kind: 'workspace', scope_key: null,
      reason_code: 'restore_in_progress', blocked_action_kinds: ['dial_authorization'], source_event_kind: 'restore', source_event_id: null,
      owner_user_id: null, started_at: new Date(state.now), recovery_action: null }] : [];
    else if (sql.startsWith('SELECT sum(cents)::text')) rows = [{ cents: String(state.spent + openCents()) }];
    else if (sql.startsWith('WITH spend AS')) rows = [{ today: String(state.spent + openCents()), month: String(state.monthlySpent + openCents()) }];
    else if (sql.startsWith('SELECT count(*) FILTER')) {
      const self = state.session && state.sessionId !== values[3];
      rows = [{ today: state.today + (self && state.consumed ? 1 : 0), recent: state.recent + (self && state.consumed ? 1 : 0),
        active: state.active || (self && ((!state.consumed && state.now < state.expires) || (state.consumed && ['authorized', 'ringing', 'in_progress'].includes(state.status)))) }];
    } else if (sql.startsWith('INSERT INTO browser_audio_test_requests')) {
      state.request = true; state.requestId = String(values[1]); state.e164 = String(values[6]);
      state.expires = new Date(Date.parse(String(values[7])) + 60000).toISOString(); rows = [{ expires_at: new Date(state.expires) }];
    } else if (sql.startsWith('INSERT INTO provider_reservations')) {
      state.reservation = true; state.businessDate = String(values[3]); state.cents = Number(values[5]);
      state.reservationMaxMinutes = Number(values[6]); state.reservationState = 'reserved'; rows = [{ id: ids.reservation }];
    } else if (sql.startsWith('INSERT INTO call_sessions')) { state.session = true; state.sessionId = String(values[0]); count = 1; }
    else if (sql.startsWith('UPDATE call_sessions SET consumed_at')) {
      state.consumed = true; state.consumedAt = new Date(String(values[3])); count = 1;
    } else if (sql.startsWith('UPDATE call_sessions SET recording_sid')) {
      state.recordingPath = values[3] === null ? state.recordingPath : String(values[3]);
      state.recordingSeconds = values[4] === null ? state.recordingSeconds : Number(values[4]); count = 1;
    } else if (sql.startsWith('UPDATE call_sessions SET status')) {
      state.status = String(values[2]); state.providerStatus = String(values[3]);
      if (state.status === 'in_progress') state.answeredAt = new Date(state.now);
      if (values[6] !== null) state.duration = Number(values[6]);
      if (values[7] !== null) state.billed = Number(values[7]); count = 1;
    } else if (sql.startsWith('UPDATE call_sessions SET duration_seconds')) {
      if (state.duration === null && values[2] !== null) state.duration = Number(values[2]);
      if (values[3] !== null) state.billed = Number(values[3]); count = 1;
    } else if (sql.startsWith('UPDATE provider_reservations SET state = \'calling\'')) {
      if (state.reservationState === 'reserved') { state.reservationState = 'calling'; count = 1; } else count = 0;
    } else if (sql.startsWith('UPDATE provider_reservations SET state = $3')) {
      if (['reserved', 'calling'].includes(state.reservationState)) {
        state.reservationState = String(values[2]); state.settledCents = state.reservationState === 'settled' ? Number(values[3]) : state.reservationState === 'estimated' ? Number(values[6] ?? state.cents) : 0;
        rows = [rowReservation()];
      }
    } else if (sql.startsWith('WITH old AS')) {
      if (state.settledCents !== Number(values[2]) || state.reservationState !== 'settled') {
        rows = [{ previous: state.settledCents, ...rowReservation() }]; state.reservationState = 'settled'; state.settledCents = Number(values[2]);
      }
    } else if (sql.startsWith('INSERT INTO provider_ledger')) { state.ledgerCents += Number(values[4]); count = 1; }
    else if (sql.includes('UPDATE browser_audio_test_requests')) {
      if (!state.erasedAt && (state.now >= state.expires || ['completed', 'failed', 'canceled'].includes(state.status))) {
        state.e164 = null; state.erasedAt = new Date(state.now); count = 1;
      } else count = 0;
    } else if (sql.includes('FROM command_receipts')) rows = state.receipt && values[4] === state.payloadHash ? [{ result_status: state.receiptStatus, result: { sessionId: state.sessionId, expiresAt: state.expires } }] : [];
    else if (sql.startsWith('SELECT s.reservation_id')) rows = state.reservation && ['reserved', 'calling'].includes(state.reservationState)
      && ((!state.consumed && state.now >= state.expires) || (state.consumedAt && Date.parse(state.now) >= state.consumedAt.getTime() + 960000))
      ? [{ reservation_id: ids.reservation, consumed: state.consumed }] : [];
    else if (sql.includes('SELECT DISTINCT s.workspace_id')) rows = [{ workspace_id: ids.workspace }];
    else if (sql.includes('FROM browser_audio_test_requests r') || sql.includes('JOIN browser_audio_test_requests r')) rows = state.session && state.request ? [rowRequest()] : [];
    else if (sql.includes('FROM call_sessions')) {
      const businessOnly = sql.includes("purpose='business'");
      rows = state.session && (!businessOnly || state.purpose === 'business') ? [rowSession()] : [];
    } else if (sql.includes('FROM provider_reservations')) rows = state.reservation ? [rowReservation()] : [];
    else throw new Error(`unexpected SQL in audio test fake: ${sql}`);
    return { rows: rows as Row[], rowCount: count ?? rows.length };
  } };
  const context = repositoryContext(workspaceScope(ids.workspace, { kind: 'user', userId: ids.user, role: 'admin' }), db);
  return { state, trace, hooks, db, context };
}
