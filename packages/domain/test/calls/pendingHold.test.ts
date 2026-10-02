import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firmPageResponseSchema, HOLD_REASON_CODES } from '@fss/contracts';
import { readNeedsReview } from '../../calls/needsReview.ts';
import { dismissPendingHold } from '../../calls/pendingHold.ts';
import { recordCallRecording, recordCallStatus } from '../../calls/sessions.ts';
import { readFirmPage } from '../../crm/firmPage.ts';
import { withTransaction } from '../../db/queryable.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { listApplicableHolds } from '../../policy/holds.ts';
import { commitDeletion, previewDeletion } from '../../retention/deletion.ts';
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

  // Review S3B, finding 2: the session's deletion releases its hold, in the same transaction.
  const pendingInReview = async (sessionId: string): Promise<boolean> =>
    (await readNeedsReview(world.admin())).items.some(item => item.source === 'pending_hold' && item.callSessionId === sessionId);
  const blocksEmail = async (firmId: string): Promise<boolean> =>
    (await listApplicableHolds(world.system(), { actionKind: 'email_send', firmId })).length > 0;

  it("deleting the call's contact releases its pending hold: the surviving firm has no blocking hold, and Needs review is clean", async () => {
    const firm = await world.newFirm();
    // A second person at the firm, so the firm survives with someone to work.
    await world.session.query(
      `INSERT INTO contacts (workspace_id, firm_id, full_name, title, is_primary) VALUES ($1, $2, 'Riley Example', 'Owner', false)`,
      [world.seeded.alpha.workspaceId, firm.firmId],
    );
    const call = await place(firm, [{ status: 'in-progress' }, { status: 'completed', seconds: 125 }]);
    expect(await holdsOf(call.sessionId)).toEqual([expect.objectContaining({ released: false })]);
    // Open for four hours: Needs review lists it until the deletion.
    await world.session.query(
      "UPDATE active_holds SET started_at = now() - interval '4 hours' WHERE source_event_kind = 'call_analysis_pending' AND source_event_id = $1",
      [call.sessionId],
    );
    expect(await pendingInReview(call.sessionId)).toBe(true);
    expect(await blocksEmail(firm.firmId)).toBe(true);

    const deleted = await withTransaction(world.session, async () => {
      const preview = await previewDeletion(world.admin(), { targetKind: 'contact', firmId: firm.firmId, contactId: firm.contactId });
      if (!preview.ok) throw new Error(`preview refused: ${JSON.stringify(preview)}`);
      return await commitDeletion(world.admin(), {
        requestId: preview.value.requestId,
        previewHash: preview.value.previewHash,
        commandId: `delete-contact-${call.sessionId}`,
        journal: recordingSuppressionJournal(),
      });
    });
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    expect((await world.session.query('SELECT 1 FROM call_sessions WHERE id = $1', [call.sessionId])).rows).toHaveLength(0);
    const [released] = await holdsOf(call.sessionId);
    expect(released).toMatchObject({ released: true });
    // The deletion's audit names the holds it released.
    const { rows: audit } = await world.session.query<{ ids: string[] }>(
      `SELECT ARRAY(SELECT jsonb_array_elements_text(detail->'releasedPendingHoldIds')) AS ids
         FROM audit_events WHERE action = 'deletion.committed' AND subject_id = $1`,
      [firm.contactId],
    );
    expect(audit.map(row => row.ids)).toEqual([[released?.id]]);
    expect(await blocksEmail(firm.firmId)).toBe(false);
    expect(await pendingInReview(call.sessionId)).toBe(false);
  });

  it('a pending hold whose session is gone is still listed at its firm, and Dismiss releases it', async () => {
    const firm = await world.newFirm();
    const { rows } = await world.session.query<{ id: string; ghost: string }>(
      `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind,
                                 source_event_id, recovery_action, started_at)
       SELECT $1, 'firm', $2, 'scoped_pause', ARRAY['email_send', 'enrollment_advance', 'call_task'], 'call_analysis_pending',
              g.id::text, 'review_call', now() - interval '4 hours'
         FROM (SELECT gen_random_uuid() AS id) g
       RETURNING id, source_event_id AS ghost`,
      [world.seeded.alpha.workspaceId, firm.firmId],
    );
    const ghost = rows[0]?.ghost ?? '';
    expect(await pendingInReview(ghost)).toBe(true);
    const dismissed = await withTransaction(world.session, async () => await dismissPendingHold(world.salesperson(), { callSessionId: ghost }));
    expect(dismissed).toEqual({ ok: true, value: { callSessionId: ghost, releasedHoldId: rows[0]?.id } });
    expect(await blocksEmail(firm.firmId)).toBe(false);
    expect(await pendingInReview(ghost)).toBe(false);
  });
});
