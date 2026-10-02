import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { correctCallOutcomeCommandSchema, type CallCorrectionEffect } from '@fss/contracts';
import { taskKey } from '../../calls/analysisPolicy.ts';
import { correctCallOutcome } from '../../calls/correctOutcome.ts';
import { createCallSession, listFirmCallSessions } from '../../calls/sessions.ts';
import { listCallLogs } from '../../dial/calls.ts';
import { withTransaction } from '../../db/queryable.ts';
import { scheduleCallbackForCall } from '../../dial/callbacks.ts';
import { consumeFollowUpPermission } from '../../sequences/followUpPermissions.ts';
import { recordAdminSupersession } from '../../suppression/events.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { databaseNow } from '../../policy/clock.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import { callbackTimeNeededItemKey } from '../../today/types.ts';
import { answer, lines } from './analysisFixtures.ts';
import { apply, createApplyWorld, type ApplyWorld, type TestFirm } from './support/applyWorld.ts';
import {
  callbackFields,
  correct,
  david,
  keepAll,
  logFormCall,
  placeSeries,
  preview,
  scalar,
  undoAll,
} from './support/correctionWorld.ts';

/**
 * S3X lane X2 — the correction command through the real writers (DESIGN-S3X §3, §4, §6).
 *
 *   * X2-1: each row of §4's correction table, with the final rows asserted;
 *   * X2-2: P3's refusals — a decision missing or not allowed, nothing preselectable,
 *     `stop_needs_admin`;
 *   * X2-3: `effects_changed` — a callback scheduled, a permission consumed, between the
 *     preview and the correct;
 *   * X2-4: atomicity — an inner refusal leaves the outcome, the callbacks, the permissions
 *     and the journal as they were;
 *   * X2-9: firm-scope park discovery against the recomputed cadence;
 *   * X2-12: the Today revival (S3XD 5);
 *   * CC8: a correction with "Lift stop…" writes no supersession and leaves the stop
 *     effective; the follow-up lift is exactly the existing admin supersession.
 */

const PROMISE = 'I will send you the pricing sheet today';
const TASK_CALL = lines(
  ['Y', 'Hi Dana, this is David from Callie.'],
  ['T', 'Tell me more.'],
  ['Y', `Sure. ${PROMISE}.`],
  ['T', 'Call me back Thursday at 2.'],
);
/** An outcome (`callback_requested`) and a promise: the task is on the session. */
const TASK_READING = answer({
  summary: 'Dana wanted to hear more and a callback Thursday at 2; David promised the pricing sheet.',
  interest: { level: 'curious', signals: [] },
  commitments: [{ speaker: 'you', quote: PROMISE, line: 3, due_phrase: 'today' }],
  callback: { requested: true, exact: true, phrase: 'Call me back Thursday at 2', line: 4, agreed_line: 0, day: 'thursday', date_text: 'Thursday', time: '2' },
});
const SIGNAL_CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Can you show us a demo?']);
const SIGNAL_READING = answer({
  summary: 'Dana asked for a demo.',
  interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
});

describe('X2: correcting a logged outcome', () => {
  let world: ApplyWorld;
  let templateVersionId: string;

  beforeAll(async () => {
    world = await createApplyWorld();
    const firm = await world.newFirm();
    const { rows } = await world.session.query<{ id: string }>(
      `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body,
                                      content_hash, footer_sign_off, approved_at, approved_by_user_id)
       SELECT w.workspace_id, gen_random_uuid(), 1, 'The overview', 'A question about {firm_name}',
              'Hello {contact_first_name}.', encode(sha256(random()::text::bytea), 'hex'), 'Sam Example', now(), w.user_id
         FROM workspace_memberships w
        WHERE w.workspace_id = (SELECT workspace_id FROM firms WHERE id = $1) AND w.role = 'admin'
        LIMIT 1
       RETURNING id`,
      [firm.firmId],
    );
    templateVersionId = rows[0]?.id ?? '';
  });
  afterAll(async () => {
    await world.drop();
  });

  const outcomeOf = async (logId: string) => await scalar<string>(world, 'SELECT outcome AS v FROM call_logs WHERE id = $1', [logId]);
  const callbackStatus = async (logId: string) =>
    (await world.session.query<{ status: string; cancelled_reason: string | null }>('SELECT status, cancelled_reason FROM callbacks WHERE call_log_id = $1 ORDER BY created_at', [logId])).rows;
  const effective = async (eventId: string) =>
    await scalar<boolean>(world, 'SELECT NOT EXISTS (SELECT 1 FROM suppression_events WHERE supersedes_event_id = $1) AS v', [eventId]);
  const parkOpen = async (holdId: string) => await scalar<boolean>(world, 'SELECT released_at IS NULL AS v FROM active_holds WHERE id = $1', [holdId]);
  const ofKind = (effects: readonly CallCorrectionEffect[], kind: CallCorrectionEffect['kind']) => effects.filter(effect => effect.kind === kind);

  // ---------------------------------------------------------------------------------------
  // X2-1: §4's correction table
  // ---------------------------------------------------------------------------------------

  describe('X2-1: the correction table', () => {
    it('do_not_call → reached: the stop is Keep stop / Lift stop…, and neither lifts it; manual mode also happens', async () => {
      const firm = await world.newFirm({ opportunity: 'open' });
      const logId = await logFormCall(world, firm, 'do_not_call', {}, world.session, db => david(world, db));
      await world.session.query("UPDATE opportunities SET control_mode = 'automated' WHERE firm_id = $1", [firm.firmId]);
      const shown = await preview(world, logId, 'interested', david(world));
      const [stop] = ofKind(shown.effects, 'stop');
      expect(stop).toMatchObject({ conflicts: true, decisions: ['keep', 'lift'], state: 'effective' });
      expect(shown.alsoHappens).toContain('manual_mode');
      const corrected = await correct(world, logId, 'interested', { decide: undoAll, context: db => david(world, db) });
      expect(corrected.ok, JSON.stringify(corrected)).toBe(true);
      if (!corrected.ok) return;
      expect(corrected.value.liftNext).toEqual([{ eventId: stop?.id, scope: 'handle', channel: 'phone' }]);
      expect(await outcomeOf(logId)).toBe('interested');
      expect(await effective(stop?.id ?? '')).toBe(true);
      expect(await scalar<string>(world, "SELECT control_mode AS v FROM opportunities WHERE firm_id = $1 AND status = 'open'", [firm.firmId])).toBe('manual');
    });

    it('reached → do_not_call: the default {contact, phone} stop is written; an open callback, the agreement and its permission are undone', async () => {
      const firm = await world.newFirm();
      const logId = await logFormCall(world, firm, 'callback_requested', {
        callback: callbackFields(),
        followUpPermission: { scope: 'single_email', templateVersionId },
      });
      const shown = await preview(world, logId, 'do_not_call');
      expect(ofKind(shown.effects, 'callback').map(effect => [effect.conflicts, effect.decisions])).toEqual([[true, ['keep', 'undo']]]);
      expect(ofKind(shown.effects, 'permission').map(effect => [effect.conflicts, effect.decisions])).toEqual([[true, ['undo']]]);
      const journal = recordingSuppressionJournal();
      const corrected = await correct(world, logId, 'do_not_call', { decide: undoAll, journal });
      expect(corrected.ok, JSON.stringify(corrected)).toBe(true);
      expect(await callbackStatus(logId)).toEqual([{ status: 'cancelled', cancelled_reason: 'call outcome corrected' }]);
      expect(await scalar<boolean>(world, 'SELECT revoked_at IS NOT NULL AS v FROM follow_up_permissions WHERE call_log_id = $1', [logId])).toBe(true);
      expect(await scalar<string | null>(world, 'SELECT agreed_follow_up AS v FROM call_logs WHERE id = $1', [logId])).toBeNull();
      expect(journal.appended.map(record => [record.scope, record.channel, record.source])).toEqual([['handle', 'phone', 'prospect_do_not_call']]);
      expect(corrected.ok && corrected.value.applied.suppressionEventIds).toEqual([journal.appended[0]?.eventId]);
    });

    it('callback_requested → a reached outcome: Keep leaves the callback open, and the agreement stays', async () => {
      const firm = await world.newFirm();
      const logId = await logFormCall(world, firm, 'callback_requested', {
        callback: callbackFields(),
        followUpPermission: { scope: 'single_email', templateVersionId },
      });
      const shown = await preview(world, logId, 'not_interested');
      expect(ofKind(shown.effects, 'permission').every(effect => !effect.conflicts)).toBe(true);
      expect(shown.alsoHappens).toContain('suggest_lost');
      const corrected = await correct(world, logId, 'not_interested', { decide: keepAll });
      expect(corrected.ok && corrected.value.suggestedStageKey).toBe('lost');
      expect(await callbackStatus(logId)).toEqual([{ status: 'open', cancelled_reason: null }]);
      expect(await scalar<string | null>(world, 'SELECT agreed_follow_up AS v FROM call_logs WHERE id = $1', [logId])).toBe('single_email');
    });

    it('reached → unanswered: the call tasks are undone (and their Today task with them)', async () => {
      const firm = await world.newFirm();
      const call = await world.analyse(await world.placeCall(firm, TASK_CALL), TASK_READING);
      const applied = await apply(world, call, ['outcome', taskKey(PROMISE)]);
      expect(applied.ok, JSON.stringify(applied)).toBe(true);
      const logId = applied.ok ? (applied.value.callLogId ?? '') : '';
      const corrected = await correct(world, logId, 'no_answer', { decide: undoAll, reason: 'new_information' });
      expect(corrected.ok, JSON.stringify(corrected)).toBe(true);
      expect(await scalar<string>(world, 'SELECT status AS v FROM call_tasks WHERE call_session_id = $1', [call.sessionId])).toBe('cancelled');
      expect(
        await scalar<number>(
          world,
          "SELECT count(*)::int AS v FROM today_items WHERE firm_id = $1 AND item_key LIKE 'call-task:%' AND status IN ('open', 'snoozed')",
          [firm.firmId],
        ),
      ).toBe(0);
    });

    it('reached → unanswered: the correction that spends the cadence parks the firm (automatic)', async () => {
      const firm = await world.newFirm();
      const { logIds } = await placeSeries(world, firm, ['no_answer', 'no_answer', 'no_answer', 'interested']);
      const corrected = await correct(world, logIds[3] ?? '', 'no_answer');
      expect(corrected.ok, JSON.stringify(corrected)).toBe(true);
      const parkId = corrected.ok ? corrected.value.applied.parkHoldId : null;
      expect(parkId).not.toBeNull();
      expect(await parkOpen(parkId ?? '')).toBe(true);
    });

    it('unanswered → reached: an automatic park the recomputed cadence no longer justifies is keep or release', async () => {
      const firm = await world.newFirm();
      const { logIds } = await placeSeries(world, firm, ['no_answer', 'no_answer', 'no_answer', 'no_answer']);
      const parkId = await scalar<string>(world, "SELECT id AS v FROM active_holds WHERE scope_key = $1 AND source_event_kind = 'call_cadence_parked' AND released_at IS NULL", [firm.firmId]);
      const kept = await correct(world, logIds[2] ?? '', 'interested', { decide: keepAll });
      expect(kept.ok, JSON.stringify(kept)).toBe(true);
      expect(await parkOpen(parkId)).toBe(true);
      // The same call corrected again, now releasing it (X2-9 through the command).
      const released = await correct(world, logIds[2] ?? '', 'referral_or_wrong_person', { decide: undoAll });
      expect(released.ok, JSON.stringify(released)).toBe(true);
      expect(await parkOpen(parkId)).toBe(false);
      expect(await scalar<number>(world, "SELECT count(*)::int AS v FROM audit_events WHERE action = 'call.cadence_resumed' AND subject_id = $1", [parkId])).toBe(1);
    });

    it('anything → callback_requested: a completed needs-a-time task makes the time required', async () => {
      const firm = await world.newFirm();
      const logId = await logFormCall(world, firm, 'callback_requested');
      await world.session.query("UPDATE today_items SET status = 'completed', completed_at = now() WHERE item_key = $1", [callbackTimeNeededItemKey(logId)]);
      expect((await correct(world, logId, 'no_answer')).ok).toBe(true);
      const shown = await preview(world, logId, 'callback_requested');
      expect(shown.callbackTimeRequired).toBe(true);
      expect(await correct(world, logId, 'callback_requested')).toEqual({ ok: false, reason: 'callback_time_required' });
      const timed = await correct(world, logId, 'callback_requested', { callback: callbackFields() });
      expect(timed.ok && timed.value.applied.callbackId).toEqual(expect.any(String));
    });

    it('wrong_number → another outcome: the retired route is keep only, and stays retired', async () => {
      const firm = await world.newFirm();
      const logId = await logFormCall(world, firm, 'wrong_number');
      const shown = await preview(world, logId, 'interested');
      expect(ofKind(shown.effects, 'route')).toEqual([expect.objectContaining({ id: firm.routeId, conflicts: true, decisions: ['keep'], state: 'retired' })]);
      expect((await correct(world, logId, 'interested')).ok).toBe(true);
      expect(await scalar<string>(world, 'SELECT eligibility AS v FROM phone_routes WHERE id = $1', [firm.routeId])).toBe('retired');
    });

    it('another outcome → wrong_number: the route is retired (automatic)', async () => {
      const firm = await world.newFirm();
      const logId = await logFormCall(world, firm, 'no_answer');
      const corrected = await correct(world, logId, 'wrong_number');
      expect(corrected.ok && corrected.value.applied.retiredRouteId).toBe(firm.routeId);
      expect(await scalar<string>(world, 'SELECT eligibility AS v FROM phone_routes WHERE id = $1', [firm.routeId])).toBe('retired');
    });

    it('any: a deal, manual mode and the ended enrollments are never changed (collapsed lines)', async () => {
      const firm = await world.newFirm();
      const call = await world.analyse(await world.placeCall(firm, SIGNAL_CALL), SIGNAL_READING);
      const applied = await apply(world, call, ['outcome', 'buying_signal']);
      expect(applied.ok, JSON.stringify(applied)).toBe(true);
      const logId = applied.ok ? (applied.value.callLogId ?? '') : '';
      const shown = await preview(world, logId, 'no_answer');
      expect(ofKind(shown.effects, 'deal').map(effect => effect.conflicts)).toEqual([false]);
      expect(ofKind(shown.effects, 'history').map(effect => effect.conflicts)).toEqual([false]);
      const corrected = await correct(world, logId, 'no_answer', { reason: 'original_error' });
      expect(corrected.ok, JSON.stringify(corrected)).toBe(true);
      expect(
        await world.session.query("SELECT status, control_mode FROM opportunities WHERE firm_id = $1", [firm.firmId]).then(result => result.rows),
      ).toEqual([{ status: 'open', control_mode: 'manual' }]);
    });
  });

  // ---------------------------------------------------------------------------------------
  // X2-2: P3's refusals
  // ---------------------------------------------------------------------------------------

  describe('X2-2: every conflicting effect needs an explicit, allowed decision', () => {
    async function permitted(): Promise<{ firm: TestFirm; logId: string }> {
      const firm = await world.newFirm();
      return { firm, logId: await logFormCall(world, firm, 'interested', { followUpPermission: { scope: 'single_email', templateVersionId } }) };
    }

    it('a missing decision: an effect left out is effects_changed; an effect without a decision does not parse', async () => {
      const { logId } = await permitted();
      expect(await correct(world, logId, 'no_answer', { shown: { ...(await preview(world, logId, 'no_answer')), effects: [] } })).toEqual({ ok: false, reason: 'effects_changed' });
      const shown = await preview(world, logId, 'no_answer');
      const [permission] = ofKind(shown.effects, 'permission');
      const body = {
        commandId: randomUUID(),
        clientVersion: '1.0.30',
        callLogId: logId,
        expectedOutcome: 'interested',
        outcome: 'no_answer',
        effects: [{ kind: 'permission', id: permission?.id, state: permission?.state }],
      };
      // Nothing is preselected: the server has no default decision.
      expect(correctCallOutcomeCommandSchema.safeParse(body).success).toBe(false);
      expect(correctCallOutcomeCommandSchema.safeParse({ ...body, effects: [{ ...body.effects[0], decision: 'undo' }] }).success).toBe(true);
    });

    it('keep on an agreement under an unreached outcome, undo on a retired route, and a duplicated decision are invalid_input', async () => {
      const { logId } = await permitted();
      expect(await correct(world, logId, 'no_answer', { decide: () => 'keep' })).toEqual({ ok: false, reason: 'invalid_input' });
      const firm = await world.newFirm();
      const wrong = await logFormCall(world, firm, 'wrong_number');
      expect(await correct(world, wrong, 'interested', { decide: () => 'undo' })).toEqual({ ok: false, reason: 'invalid_input' });
      const shown = await preview(world, logId, 'no_answer');
      const doubled = { ...shown, effects: [...shown.effects, ...shown.effects.filter(effect => effect.conflicts)] };
      expect(await correct(world, logId, 'no_answer', { shown: doubled, decide: undoAll })).toEqual({ ok: false, reason: 'invalid_input' });
      // Nothing was written by any of them.
      expect(await outcomeOf(logId)).toBe('interested');
    });

    it('stop_needs_admin: a salesperson may keep a stop but not mark it for lifting', async () => {
      const firm = await world.newFirm();
      const logId = await logFormCall(world, firm, 'do_not_call');
      const shown = await preview(world, logId, 'interested');
      expect(ofKind(shown.effects, 'stop').map(effect => effect.decisions)).toEqual([['keep']]);
      expect(await correct(world, logId, 'interested', { decide: () => 'lift' })).toEqual({ ok: false, reason: 'stop_needs_admin' });
      expect((await correct(world, logId, 'interested', { decide: () => 'keep' })).ok).toBe(true);
    });

    it('not_call_actor, stale_outcome, outcome_unchanged, outcome_not_correctable and route_not_named', async () => {
      const firm = await world.newFirm();
      const logId = await logFormCall(world, firm, 'interested');
      expect(await correct(world, logId, 'no_answer', { shown: await preview(world, logId, 'no_answer'), context: db => world.admin(db) })).toEqual({
        ok: false,
        reason: 'not_call_actor',
      });
      const shown = await preview(world, logId, 'no_answer');
      expect(await correct(world, logId, 'no_answer', { shown: { ...shown, currentOutcome: 'busy' } })).toEqual({ ok: false, reason: 'stale_outcome' });
      expect(await correct(world, logId, 'interested', { shown })).toEqual({ ok: false, reason: 'outcome_unchanged' });
      const inbound = await logFormCall(world, firm, 'interested', { direction: 'inbound', routeId: undefined });
      expect(await correct(world, inbound, 'no_answer', { shown: { ...shown, currentOutcome: 'interested', effects: [] } })).toEqual({ ok: false, reason: 'outcome_not_correctable' });
      expect(await correct(world, inbound, 'do_not_call', { shown: { ...shown, currentOutcome: 'interested', effects: [] } })).toEqual({ ok: false, reason: 'route_not_named' });
    });
  });

  // ---------------------------------------------------------------------------------------
  // X2-3: effects_changed
  // ---------------------------------------------------------------------------------------

  describe('X2-3: a review that went stale is refused', () => {
    it('a callback scheduled between the preview and the correct', async () => {
      const firm = await world.newFirm();
      const logId = await logFormCall(world, firm, 'callback_requested');
      const shown = await preview(world, logId, 'no_answer');
      const scheduled = await withTransaction(world.session, async () => await scheduleCallbackForCall(world.salesperson(), { callLogId: logId, ...callbackFields() }));
      expect(scheduled.ok).toBe(true);
      expect(await correct(world, logId, 'no_answer', { shown })).toEqual({ ok: false, reason: 'effects_changed' });
      expect(await outcomeOf(logId)).toBe('callback_requested');
    });

    it('the permission consumed by a claim between the preview and the correct', async () => {
      const firm = await world.newFirm();
      const logId = await logFormCall(world, firm, 'interested', { followUpPermission: { scope: 'single_email', templateVersionId } });
      const shown = await preview(world, logId, 'no_answer');
      const permissionId = ofKind(shown.effects, 'permission')[0]?.id ?? '';
      expect(await withTransaction(world.session, async () => await consumeFollowUpPermission(world.system(), permissionId))).toBe(true);
      expect(await correct(world, logId, 'no_answer', { shown, decide: undoAll })).toEqual({ ok: false, reason: 'effects_changed' });
      // The fresh review shows it as already sent, and the revoke is still the only choice.
      const fresh = await preview(world, logId, 'no_answer');
      expect(ofKind(fresh.effects, 'permission').map(effect => [effect.state, effect.decisions])).toEqual([['consumed', ['undo']]]);
      expect((await correct(world, logId, 'no_answer', { shown: fresh, decide: undoAll })).ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------
  // X2-4: atomic
  // ---------------------------------------------------------------------------------------

  it('X2-4: an inner refusal after earlier writes leaves the outcome, the callback, the permission and the journal as they were', async () => {
    const firm = await world.newFirm();
    const logId = await logFormCall(world, firm, 'callback_requested', {
      callback: callbackFields(),
      followUpPermission: { scope: 'single_email', templateVersionId },
    });
    // An automatic park on the firm: with this call corrected the cadence does not justify it.
    const { rows: holds } = await world.session.query<{ id: string }>(
      `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, recovery_action)
       VALUES ($1, 'firm', $2, 'scoped_pause', ARRAY['dial_authorization'], 'call_cadence_parked', 'resume_after_review') RETURNING id`,
      [world.seeded.alpha.workspaceId, firm.firmId],
    );
    const holdId = holds[0]?.id ?? '';
    // The park's release — the last undo, after the callback and the permission — finds nothing
    // to release (as if released meanwhile): the inner refusal.
    await world.session.query(
      `CREATE OR REPLACE FUNCTION x2_skip_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
       CREATE TRIGGER x2_skip_release BEFORE UPDATE ON active_holds FOR EACH ROW WHEN (OLD.id = '${holdId}'::uuid) EXECUTE FUNCTION x2_skip_release();`,
    );
    try {
      const shown = await preview(world, logId, 'do_not_call');
      expect(shown.effects.filter(effect => effect.conflicts).map(effect => effect.kind)).toEqual(['callback', 'permission', 'park']);
      const journal = recordingSuppressionJournal();
      expect(await correct(world, logId, 'do_not_call', { shown, decide: undoAll, journal })).toEqual({ ok: false, reason: 'effects_changed' });
      expect(await outcomeOf(logId)).toBe('callback_requested');
      expect(await callbackStatus(logId)).toEqual([{ status: 'open', cancelled_reason: null }]);
      expect(await scalar<boolean>(world, 'SELECT revoked_at IS NULL AS v FROM follow_up_permissions WHERE call_log_id = $1', [logId])).toBe(true);
      expect(await scalar<string | null>(world, 'SELECT agreed_follow_up AS v FROM call_logs WHERE id = $1', [logId])).toBe('single_email');
      expect(journal.appended).toEqual([]);
      expect(await scalar<number>(world, "SELECT count(*)::int AS v FROM audit_events WHERE subject_id = $1 AND action = 'call.outcome_corrected'", [logId])).toBe(0);
    } finally {
      await world.session.query('DROP TRIGGER x2_skip_release ON active_holds; DROP FUNCTION x2_skip_release();');
    }
  });

  // ---------------------------------------------------------------------------------------
  // X2-10: the database-only read, and corrections by call log id
  // ---------------------------------------------------------------------------------------

  it('X2-10: a form log, an incoming log and a log linked to an unconsumed session are all listed and corrected by call log id', async () => {
    const firm = await world.newFirm();
    const form = await logFormCall(world, firm, 'no_answer');
    const inbound = await logFormCall(world, firm, 'interested', { direction: 'inbound', routeId: undefined, durationSeconds: 60 });
    const created = await withTransaction(world.session, async () =>
      await createCallSession(world.salesperson(), {
        firmId: firm.firmId,
        contactId: firm.contactId,
        routeId: firm.routeId,
        routeVersion: firm.routeVersion,
        callingIdentityId: world.policy.alpha.callingIdentityId,
        deviceId: world.seeded.alpha.salesperson.deviceId,
        commandId: `x2-10-${randomUUID()}`,
        configuredCallerIdE164: '+14015550100',
        at: world.policy.insideWindow,
      }),
    );
    if (!created.ok) throw new Error(created.reason);
    const unconsumed = await logFormCall(world, firm, 'busy', { routeId: undefined, contactId: undefined, callSessionId: created.value.sessionId });
    // The session read starts from consumed sessions: it never shows this log.
    expect((await listFirmCallSessions(world.salesperson(), firm.firmId))?.map(session => session.callLogId)).toEqual([]);
    const rows = await listCallLogs(world.salesperson(), { firmId: firm.firmId });
    expect(new Map(rows.map(row => [row.id, [row.direction, row.callSessionId]]))).toEqual(
      new Map([
        [form, ['outbound', null]],
        [inbound, ['inbound', null]],
        [unconsumed, ['outbound', created.value.sessionId]],
      ]),
    );
    for (const [logId, target] of [
      [form, 'voicemail_left'],
      [inbound, 'referral_or_wrong_person'],
      [unconsumed, 'no_answer'],
    ] as const) {
      const corrected = await correct(world, logId, target);
      expect(corrected.ok, `${logId}: ${JSON.stringify(corrected)}`).toBe(true);
      expect(await outcomeOf(logId)).toBe(target);
    }
  });

  // ---------------------------------------------------------------------------------------
  // X2-12: Today revival
  // ---------------------------------------------------------------------------------------

  it('X2-12: callback_requested → no_answer → callback_requested on one business day: the needs-a-time task is open again', async () => {
    const firm = await world.newFirm();
    const logId = await logFormCall(world, firm, 'callback_requested');
    const today = await businessDateOf(world.system(), await databaseNow(world.system()));
    const statusToday = async () =>
      await scalar<string>(world, 'SELECT status AS v FROM today_items WHERE item_key = $1 AND snapshot_date = $2::date', [callbackTimeNeededItemKey(logId), today]);
    expect(await statusToday()).toBe('open');
    expect((await correct(world, logId, 'no_answer')).ok).toBe(true);
    expect(await statusToday()).toBe('cancelled');
    const revived = await correct(world, logId, 'callback_requested');
    expect(revived.ok, JSON.stringify(revived)).toBe(true);
    // FoR: without the reopen the refresh's upsert leaves the cancelled row as it is.
    expect(await statusToday()).toBe('open');
    expect(revived.ok && revived.value.applied.reopenedTodayItemId).toEqual(expect.any(String));
  });

  // ---------------------------------------------------------------------------------------
  // CC8: no supersession
  // ---------------------------------------------------------------------------------------

  it('CC8: "Lift stop…" appends no supersession and leaves the stop effective; the confirmed lift is exactly one admin supersession; cancelling leaves it', async () => {
    const firm = await world.newFirm();
    const logId = await logFormCall(world, firm, 'do_not_call', { doNotCall: { scope: 'firm', channel: 'all' } }, world.session, db => david(world, db));
    const journal = recordingSuppressionJournal();
    const corrected = await correct(world, logId, 'interested', { decide: undoAll, context: db => david(world, db), journal });
    expect(corrected.ok, JSON.stringify(corrected)).toBe(true);
    if (!corrected.ok) return;
    const lifts = corrected.value.liftNext;
    expect(lifts.map(lift => lift.scope).sort()).toEqual(['firm', 'handle']);
    // The correction itself journalled nothing and wrote no supersession.
    expect(journal.appended).toEqual([]);
    for (const lift of lifts) expect(await effective(lift.eventId)).toBe(true);
    expect(await scalar<number>(world, "SELECT count(*)::int AS v FROM suppression_events WHERE source = 'admin_supersession' AND supersedes_event_id = ANY($1::text[])", [lifts.map(lift => lift.eventId)])).toBe(0);
    const audit = await scalar<{ liftChosen: string[] }>(world, "SELECT detail AS v FROM audit_events WHERE subject_id = $1 AND action = 'call.outcome_corrected'", [logId]);
    expect(audit.liftChosen.sort()).toEqual(lifts.map(lift => lift.eventId).sort());

    // David confirms the first lift: the unchanged admin supersession, one journal object.
    const [first, second] = lifts;
    const lifted = await withTransaction(world.session, async () =>
      await recordAdminSupersession(david(world), { eventId: first?.eventId ?? '', reason: 'correction', commandId: `lift-${randomUUID()}` }),
    );
    expect(lifted.ok, JSON.stringify(lifted)).toBe(true);
    // Its one journal record, which the route appends after the commit (brief RF).
    expect(lifted.ok ? [lifted.value.journalRecord.source, lifted.value.journalRecord.supersedesEventId] : null).toEqual(['admin_supersession', first?.eventId]);
    expect(await effective(first?.eventId ?? '')).toBe(false);
    // He cancels the second confirm: it stays effective.
    expect(await effective(second?.eventId ?? '')).toBe(true);
  });

  it('a correction to do_not_call refuses without a journal, and the journal precedes the stop', async () => {
    const firm = await world.newFirm();
    const logId = await logFormCall(world, firm, 'interested');
    const shown = await preview(world, logId, 'do_not_call');
    const refused = await withTransaction(world.session, async () =>
      await correctCallOutcome(world.salesperson(), {
        callLogId: logId,
        expectedOutcome: 'interested',
        outcome: 'do_not_call',
        effects: shown.effects.filter(effect => effect.conflicts).map(effect => ({ kind: effect.kind, id: effect.id, state: effect.state, decision: 'keep' as const })),
        commandId: randomUUID(),
      }),
    );
    expect(refused).toEqual({ ok: false, reason: 'invalid_input' });
    // A lost journal write fails the whole command (the route's 503): nothing is written.
    const journal = recordingSuppressionJournal();
    journal.failNext();
    await expect(correct(world, logId, 'do_not_call', { journal })).rejects.toThrow();
    expect(await outcomeOf(logId)).toBe('interested');
  });
});
