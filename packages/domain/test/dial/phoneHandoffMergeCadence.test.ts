import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CallOutcome } from '@fss/contracts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { createFirm, resolveZoneForFirm } from '../../crm/firms.ts';
import { mergeFirms } from '../../crm/merges.ts';
import { readCallCadence } from '../../calls/cadence.ts';
import { correctCallOutcome, previewOutcomeCorrection } from '../../calls/correctOutcome.ts';
import { consumeCallSession, createCallSession } from '../../calls/sessions.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { reservePhoneHandoff } from '../../dial/phoneHandoff.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { phoneFixture, type PhoneFixture } from './phoneHandoffFixtures.ts';

let database: TestDatabase;
let f: PhoneFixture;
beforeEach(async () => {
  database = await createTestDatabase();
  f = await phoneFixture(database);
  await f.publish();
  await database.session.query('UPDATE phone_routes SET contact_id=NULL WHERE workspace_id=$1 AND id=$2', [f.w, f.policy.alpha.phoneRouteId]);
  await database.session.query(`INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id)
    VALUES($1,'telephony_budget',1,'{"dailyCeilingCents":500,"maxMinutesPerCall":30,"unitPriceMicros":14000}',$2)`, [f.w, f.seeded.alpha.admin.userId]);
});
afterEach(async () => { await database.drop(); });

async function providerSession(at: string, consumed: boolean) {
  const created = await createCallSession(f.context, { ...f.request(), at,
    callingIdentityId: f.policy.alpha.callingIdentityId, configuredCallerIdE164: '+14015550100' });
  if (!created.ok) throw new Error(created.reason);
  const sessionId = created.value.sessionId;
  if (consumed) {
    const used = await consumeCallSession(database.session, { workspaceId: f.w, sessionId,
      callSid: `CA${randomUUID().replaceAll('-', '')}`, identity: `client:${f.seeded.alpha.salesperson.userId}`, at });
    if (!used.ok) throw new Error(used.reason);
    // Keep the real consumption's identity/accounting, date its clock for the bounded fixture.
    await database.session.query('UPDATE call_sessions SET consumed_at=$2 WHERE workspace_id=$3 AND id=$1', [sessionId, at, f.w]);
  }
  return sessionId;
}

async function correct(callLogId: string, outcome: CallOutcome) {
  const shown = await previewOutcomeCorrection(f.context, { callLogId, outcome });
  if (!shown.ok) throw new Error(shown.reason);
  const result = await correctCallOutcome(f.context, { callLogId, outcome, expectedOutcome: shown.value.currentOutcome,
    commandId: randomUUID(), journal: recordingSuppressionJournal(), effects: shown.value.effects.filter(effect => effect.conflicts)
      .map(effect => ({ kind: effect.kind, id: effect.id, state: effect.state, decision: effect.decisions.includes('undo') ? 'undo' : 'keep' })) });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
}

async function merge() {
  const target = await createFirm(f.context, { name: 'Mixed provider survivor fixture', assignedUserId: f.seeded.alpha.salesperson.userId,
    regionCode: 'RI', locality: 'Providence', postalCode: '02903' });
  if (!target.ok) throw new Error(target.reason);
  expect((await resolveZoneForFirm(f.context, { firmId: target.value.id })).ok).toBe(true);
  const result = await mergeFirms(f.context, { sourceFirmId: f.crm.alpha.firmId, targetFirmId: target.value.id, journal: recordingSuppressionJournal() });
  expect(result.ok).toBe(true);
  return target.value.id;
}

describe('firm-only mixed-provider history survives merge without refunds', () => {
  it('retains three consumed Twilio attempts plus a phone attempt, and corrects the original linked Twilio reset', async () => {
    await withTransaction(database.session, async () => {
      const logs: string[] = [];
      for (const at of ['2026-09-16T14:00:00Z', '2026-09-17T16:00:00Z', '2026-09-18T14:00:00Z']) {
        const sessionId = await providerSession(at, true);
        const logged = await logCallOutcome(f.context, { firmId: f.crm.alpha.firmId, callSessionId: sessionId,
          opportunityId: null, outcome: 'no_answer', commandId: randomUUID() });
        if (!logged.ok) throw new Error(logged.reason);
        logs.push(logged.value.callLogId);
        await database.session.query('UPDATE call_logs SET occurred_at=$2 WHERE workspace_id=$3 AND id=$1', [logged.value.callLogId, at, f.w]);
      }
      expect((await database.session.query('SELECT contact_id FROM call_sessions WHERE workspace_id=$1', [f.w])).rows).toEqual([
        { contact_id: null }, { contact_id: null }, { contact_id: null },
      ]);
      expect((await database.session.query('SELECT contact_id,opportunity_id FROM call_logs WHERE workspace_id=$1', [f.w])).rows)
        .toEqual([{ contact_id: null, opportunity_id: null }, { contact_id: null, opportunity_id: null }, { contact_id: null, opportunity_id: null }]);
      const handoff = await reservePhoneHandoff(f.context, { ...f.request(), at: '2026-09-21T16:00:00Z', opportunityId: null });
      if (!handoff.ok) throw new Error(handoff.reason);
      const before = (await database.session.query(`SELECT id,ticket_id,reservation_id,twilio_call_sid,consumed_at,call_log_id,
        contact_id,created_at,expires_at FROM call_sessions WHERE workspace_id=$1 ORDER BY id`, [f.w])).rows;
      const originalLogs = (await database.session.query(`SELECT id,ticket_id,phone_route_id,calling_identity_id,occurred_at,recorded_at
        FROM call_logs WHERE workspace_id=$1 ORDER BY id`, [f.w])).rows;
      expect(await readCallCadence(f.context, f.crm.alpha.firmId, '2026-09-22T14:00:00Z')).toMatchObject({ unansweredAttempts: 4, refusal: 'call_attempts_exhausted' });
      const targetId = await merge();
      expect((await database.session.query(`SELECT id,ticket_id,reservation_id,twilio_call_sid,consumed_at,call_log_id,
        contact_id,created_at,expires_at FROM call_sessions WHERE workspace_id=$1 AND firm_id=$2 ORDER BY id`, [f.w, targetId])).rows).toEqual(before);
      expect((await database.session.query(`SELECT id,ticket_id,phone_route_id,calling_identity_id,occurred_at,recorded_at
        FROM call_logs WHERE workspace_id=$1 AND firm_id=$2 ORDER BY id`, [f.w, targetId])).rows).toEqual(originalLogs);
      expect(await readCallCadence(f.context, targetId, '2026-09-22T14:00:00Z')).toMatchObject({ unansweredAttempts: 4, refusal: 'call_attempts_exhausted' });
      expect(await reservePhoneHandoff(f.context, { ...f.request(), firmId: targetId, at: '2026-09-22T14:00:00Z' }))
        .toEqual({ ok: false, reason: 'call_attempts_exhausted' });
      expect((await database.session.query('SELECT id,firm_id FROM phone_handoff_attempts WHERE workspace_id=$1', [f.w])).rows)
        .toEqual([{ id: handoff.value.attemptId, firm_id: targetId }]);
      const lastLog = logs.at(-1);
      if (!lastLog) throw new Error('missing linked provider log');
      await correct(lastLog, 'interested');
      expect(await readCallCadence(f.context, targetId, '2026-09-22T14:00:00Z')).toMatchObject({ unansweredAttempts: 1 });
      await correct(lastLog, 'no_answer');
      expect(await readCallCadence(f.context, targetId, '2026-09-22T14:00:00Z')).toMatchObject({ unansweredAttempts: 4, refusal: 'call_attempts_exhausted' });
    });
  });

  it('does not turn a moved unconsumed session into fresh authority through its original source-bound ticket', async () => {
    await withTransaction(database.session, async () => {
      const sessionId = await providerSession(f.policy.insideWindow, false);
      const targetId = await merge();
      const row = (await database.session.query<{ firm_id: string; ticket_firm: string }>(`SELECT s.firm_id,t.firm_id AS ticket_firm
        FROM call_sessions s JOIN dial_tickets t ON t.workspace_id=s.workspace_id AND t.id=s.ticket_id
        WHERE s.workspace_id=$1 AND s.id=$2`, [f.w, sessionId])).rows[0];
      expect(row).toEqual({ firm_id: targetId, ticket_firm: f.crm.alpha.firmId });
      const consumed = await consumeCallSession(database.session, { workspaceId: f.w, sessionId,
        callSid: `CA${randomUUID().replaceAll('-', '')}`, identity: `client:${f.seeded.alpha.salesperson.userId}`, at: f.policy.insideWindow });
      expect(consumed.ok).toBe(false);
      expect((await database.session.query('SELECT consumed_at FROM call_sessions WHERE workspace_id=$1 AND id=$2', [f.w, sessionId])).rows)
        .toEqual([{ consumed_at: null }]);
      expect(await readCallCadence(f.context, targetId, f.policy.insideWindow)).toMatchObject({ unansweredAttempts: 0 });
    });
  });
});
