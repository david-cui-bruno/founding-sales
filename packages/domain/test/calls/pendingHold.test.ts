import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firmPageResponseSchema, HOLD_REASON_CODES } from '@fss/contracts';
import { dismissPendingHold } from '../../calls/pendingHold.ts';
import { recordCallRecording, recordCallStatus } from '../../calls/sessions.ts';
import { readFirmPage } from '../../crm/firmPage.ts';
import { withTransaction } from '../../db/queryable.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { listApplicableHolds } from '../../policy/holds.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { lines } from './analysisFixtures.ts';
import { createApplyWorld, type ApplyWorld, type PlacedCall, type TestFirm } from './support/applyWorld.ts';

/**
 * Slice 3a, lane B — the pending-review hold (B-7) and its firm-page read (B-12).
 *
 * Admission reads the facts a session has accumulated, on every status and recording
 * delivery, duplicates included: terminal, answered (`answered_at` or a provider status
 * of `completed`), at least 20 seconds (`duration_seconds`, else the recording's), the
 * transcription switch on, no log, and no pending hold for the session ever before.
 */

const CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Sure, go ahead.']);

describe('B-7 and B-12: the pending-review hold', () => {
  let world: ApplyWorld;

  beforeAll(async () => {
    world = await createApplyWorld();
    await world.setTranscription(true);
  });
  afterAll(async () => {
    await world.drop();
  });

  const holdsOf = async (sessionId: string) =>
    (
      await world.session.query<{ id: string; released: boolean; blocked: string[]; recovery: string; reason: string; scope_key: string }>(
        `SELECT id, released_at IS NOT NULL AS released, blocked_action_kinds AS blocked, recovery_action AS recovery,
                reason_code AS reason, scope_key
           FROM active_holds WHERE source_event_kind = 'call_analysis_pending' AND source_event_id = $1`,
        [sessionId],
      )
    ).rows;

  const status = async (call: PlacedCall, providerStatus: string, seconds?: number) =>
    await withTransaction(world.session, async () =>
      await recordCallStatus(world.session, { callSid: call.callSid, providerStatus, ...(seconds === undefined ? {} : { durationSeconds: seconds }) }),
    );
  const recording = async (call: PlacedCall, seconds: number) =>
    await withTransaction(world.session, async () =>
      await recordCallRecording(world.session, {
        callSid: call.callSid,
        recordingSid: `RE${'c'.repeat(32)}`,
        recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/RE${'c'.repeat(32)}`,
        durationSeconds: seconds,
      }),
    );
  const place = async (firm: TestFirm, statuses: { status: string; seconds?: number }[], recordingSeconds: number | null = null) =>
    await world.placeCall(firm, CALL, { statuses, recordingSeconds, transcript: false });
  const logIt = async (call: PlacedCall) =>
    await withTransaction(world.session, async () =>
      await logCallOutcome(world.salesperson(), {
        firmId: call.firm.firmId,
        callSessionId: call.sessionId,
        outcome: 'interested',
        commandId: `pending-log-${call.sessionId}`,
        journal: recordingSuppressionJournal(),
      }),
    );

  it('a terminal status before the answer, with a qualifying duration, is admitted (and the late answer changes nothing)', async () => {
    const call = await place(await world.newFirm(), [{ status: 'completed', seconds: 25 }]);
    expect(await holdsOf(call.sessionId)).toHaveLength(1);
    await status(call, 'in-progress');
    expect(await holdsOf(call.sessionId)).toEqual([expect.objectContaining({ released: false })]);
  });

  it('a terminal without a duration is not admitted; a repeat with 25 s is', async () => {
    const call = await place(await world.newFirm(), [{ status: 'in-progress' }, { status: 'completed' }]);
    expect(await holdsOf(call.sessionId)).toEqual([]);
    await status(call, 'completed', 25);
    expect(await holdsOf(call.sessionId)).toHaveLength(1);
  });

  it('a terminal without a duration is admitted by the recording that carries 25 s', async () => {
    const call = await place(await world.newFirm(), [{ status: 'in-progress' }, { status: 'completed' }]);
    expect(await holdsOf(call.sessionId)).toEqual([]);
    await recording(call, 25);
    expect(await holdsOf(call.sessionId)).toHaveLength(1);
  });

  it('duplicate deliveries give one hold', async () => {
    const call = await place(await world.newFirm(), [{ status: 'in-progress' }, { status: 'completed', seconds: 125 }], 125);
    await status(call, 'completed', 125);
    await recording(call, 125);
    await status(call, 'completed', 125);
    expect(await holdsOf(call.sessionId)).toHaveLength(1);
  });

  it('a call logged before its terminal status gets no hold', async () => {
    const call = await place(await world.newFirm(), [{ status: 'in-progress' }]);
    expect((await logIt(call)).ok).toBe(true);
    await status(call, 'completed', 125);
    await recording(call, 125);
    expect(await holdsOf(call.sessionId)).toEqual([]);
  });

  it('is released at the first log link and never reopened by a later delivery', async () => {
    const call = await place(await world.newFirm(), [{ status: 'in-progress' }, { status: 'completed', seconds: 125 }]);
    expect(await holdsOf(call.sessionId)).toEqual([expect.objectContaining({ released: false })]);
    expect((await logIt(call)).ok).toBe(true);
    expect(await holdsOf(call.sessionId)).toEqual([expect.objectContaining({ released: true })]);
    await status(call, 'completed', 125);
    await recording(call, 125);
    expect(await holdsOf(call.sessionId)).toEqual([expect.objectContaining({ released: true })]);
  });

  it('Dismiss releases it, and a later delivery does not reopen it', async () => {
    const call = await place(await world.newFirm(), [{ status: 'in-progress' }, { status: 'completed', seconds: 125 }]);
    const dismissed = await withTransaction(world.session, async () => await dismissPendingHold(world.salesperson(), { callSessionId: call.sessionId }));
    const held = await holdsOf(call.sessionId);
    expect(dismissed).toEqual({ ok: true, value: { callSessionId: call.sessionId, releasedHoldId: held[0]?.id } });
    await status(call, 'completed', 125);
    expect(await holdsOf(call.sessionId)).toEqual([expect.objectContaining({ released: true })]);
    // A second Dismiss has nothing to release.
    expect(await withTransaction(world.session, async () => await dismissPendingHold(world.salesperson(), { callSessionId: call.sessionId }))).toEqual({
      ok: true,
      value: { callSessionId: call.sessionId, releasedHoldId: null },
    });
  });

  it('nothing is held for an unanswered call, a short one, or with transcription off', async () => {
    const unanswered = await place(await world.newFirm(), [{ status: 'no-answer', seconds: 30 }]);
    const short = await place(await world.newFirm(), [{ status: 'in-progress' }, { status: 'completed', seconds: 19 }], 19);
    await world.setTranscription(false);
    const off = await place(await world.newFirm(), [{ status: 'in-progress' }, { status: 'completed', seconds: 125 }], 125);
    await world.setTranscription(true);
    for (const call of [unanswered, short, off]) expect(await holdsOf(call.sessionId)).toEqual([]);
  });

  it('blocks e-mail, enrollment advance and call tasks at the firm, and never dialling', async () => {
    const call = await place(await world.newFirm(), [{ status: 'in-progress' }, { status: 'completed', seconds: 125 }]);
    const [hold] = await holdsOf(call.sessionId);
    expect(hold).toMatchObject({ reason: 'scoped_pause', recovery: 'review_call', scope_key: call.firm.firmId });
    expect([...(hold?.blocked ?? [])].sort()).toEqual(['call_task', 'email_send', 'enrollment_advance']);
    for (const actionKind of ['email_send', 'enrollment_advance', 'call_task'] as const) {
      const holds = await listApplicableHolds(world.system(), { actionKind, firmId: call.firm.firmId });
      expect(holds.map(open => open.id)).toContain(hold?.id);
    }
    expect(await listApplicableHolds(world.system(), { actionKind: 'dial_authorization', firmId: call.firm.firmId })).toEqual([]);
  });

  it('B-12: a hold admitted by a real status delivery reads back through the firm page and parses with the 134dc811 contract', async () => {
    // `recordCallStatus` only: the answer, then the terminal status with its duration.
    const call = await place(await world.newFirm(), [{ status: 'in-progress' }, { status: 'completed', seconds: 125 }]);
    const [hold] = await holdsOf(call.sessionId);
    expect(hold).toBeDefined();
    const page = await readFirmPage(world.salesperson(), { firmId: call.firm.firmId });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    // The wire bytes an installed desktop receives. `crmSurface.ts` is unchanged since
    // 134dc811 (production) and the hold's reason is one that release already knows; its
    // `recoveryAction` is a string there, so `review_call` parses.
    const parsed = firmPageResponseSchema.parse(JSON.parse(JSON.stringify(page.value)));
    expect(parsed.visibility).toBe('assigned_or_admin');
    if (parsed.visibility !== 'assigned_or_admin') return;
    expect(parsed.holds).toEqual([
      expect.objectContaining({ id: hold?.id, reasonCode: 'scoped_pause', recoveryAction: 'review_call' }),
    ]);
    expect(HOLD_REASON_CODES).toContain('scoped_pause');
  });
});
