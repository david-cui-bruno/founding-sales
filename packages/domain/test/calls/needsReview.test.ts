import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewListResponseSchema, type ReviewItem } from '@fss/contracts';
import { readNeedsReview, resolveStageReviewItem } from '../../calls/needsReview.ts';
import { declineCallProposals } from '../../calls/proposalMeasure.ts';
import { updateFirmBasics } from '../../crm/firmBasics.ts';
import { withTransaction } from '../../db/queryable.ts';
import { scheduleCallbackForCall } from '../../dial/callbacks.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { recordSuppression } from '../../suppression/events.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { answer, lines } from './analysisFixtures.ts';
import { createApplyWorld, type Analysed, type ApplyWorld } from './support/applyWorld.ts';

/**
 * Slice 3a, lane B — B-13 (Needs review), and B-7's three hours.
 *
 * Each review kind leaves the list on its derived done condition (DESIGN-S3A §2.4) or on
 * Dismiss (a decline), and a stage item is resolved by id. A pending hold appears after
 * three hours open, whatever the call's facts, and leaves when it is released.
 */

describe('B-13: Needs review', () => {
  let world: ApplyWorld;

  beforeAll(async () => {
    world = await createApplyWorld();
  });
  afterAll(async () => {
    await world.drop();
  });

  const review = async (): Promise<readonly ReviewItem[]> => reviewListResponseSchema.parse(await readNeedsReview(world.salesperson())).items;
  const kindsFor = async (sessionId: string): Promise<string[]> =>
    (await review()).flatMap(item => (item.source === 'proposal' && item.callSessionId === sessionId ? [item.reviewKind] : []));
  const analysed = async (utterances: ReturnType<typeof lines>, reading: string, options: { readonly timeZone?: string | null } = {}): Promise<Analysed> => {
    const firm = await world.newFirm();
    const placed = await world.placeCall(firm, utterances);
    if (options.timeZone === null) {
      await world.session.query('UPDATE firms SET time_zone = NULL, time_zone_confidence = NULL, time_zone_source = NULL, time_zone_rule_version = NULL WHERE id = $1', [firm.firmId]);
    }
    return await world.analyse(placed, reading);
  };
  const log = async (call: Analysed, outcome: 'interested' | 'callback_requested' | 'not_interested') =>
    await withTransaction(world.session, async () =>
      await logCallOutcome(world.salesperson(), {
        firmId: call.firm.firmId,
        callSessionId: call.sessionId,
        outcome,
        commandId: `review-log-${call.sessionId}`,
        journal: recordingSuppressionJournal(),
      }),
    );
  const dismiss = async (call: Analysed, key: string) =>
    await withTransaction(world.session, async () =>
      await declineCallProposals(world.salesperson(), { analysisId: call.analysisId, proposalHash: call.proposalHash, keys: [key] }),
    );

  it('outcome_unclear: done when the call has a log', async () => {
    const call = await analysed(lines(['Y', 'Hi, David from Callie.'], ['T', 'Hm, okay.']), answer({ summary: 'A short call.' }));
    expect(await kindsFor(call.sessionId)).toEqual(['outcome_unclear']);
    // A proposal item names its firm.
    const { rows: named } = await world.session.query<{ name: string }>('SELECT name FROM firms WHERE id = $1', [call.firm.firmId]);
    expect((await review()).find(item => item.source === 'proposal' && item.callSessionId === call.sessionId)).toMatchObject({
      firmId: call.firm.firmId,
      firmName: named[0]?.name,
    });
    expect((await log(call, 'interested')).ok).toBe(true);
    expect(await kindsFor(call.sessionId)).toEqual([]);
  });

  it('corrected_number: done when the dialled number is replaced on the firm basics', async () => {
    const call = await analysed(
      lines(['Y', 'Is this Harbor Lane?'], ['T', 'Wrong number, this is a dental office. Harbor Lane is 617 555 0199.']),
      answer({ wrong_number: { is_wrong: true, quote: 'Wrong number', line: 2, other_number_given: '6175550199' } }),
    );
    expect(await kindsFor(call.sessionId)).toEqual(['corrected_number']);
    const replaced = await withTransaction(world.session, async () =>
      await updateFirmBasics(world.salesperson(), { firmId: call.firm.firmId, phone: { number: '+16175550199', replacesRouteId: call.firm.routeId } }),
    );
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    expect(await kindsFor(call.sessionId)).toEqual([]);
  });

  it('a wrong number on a call already logged otherwise: done when the dialled number is retired', async () => {
    // Logged from the form before the analysis completed, so nothing was bypassed; the
    // analysis then reads a wrong number the log cannot take any more.
    const firm = await world.newFirm();
    const placed = await world.placeCall(firm, lines(['Y', 'Is this Harbor Lane?'], ['T', 'Wrong number, this is a dental office.']));
    const logged = await withTransaction(world.session, async () =>
      await logCallOutcome(world.salesperson(), {
        firmId: firm.firmId,
        callSessionId: placed.sessionId,
        outcome: 'not_interested',
        commandId: `review-early-${placed.sessionId}`,
      }),
    );
    expect(logged.ok).toBe(true);
    const call = await world.analyse(placed, answer({ wrong_number: { is_wrong: true, quote: 'Wrong number', line: 2, other_number_given: '' } }));
    expect(await kindsFor(call.sessionId)).toEqual(['outcome']);
    const replaced = await withTransaction(world.session, async () =>
      await updateFirmBasics(world.salesperson(), { firmId: firm.firmId, phone: { number: '+16175550188', replacesRouteId: firm.routeId } }),
    );
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    expect(await kindsFor(call.sessionId)).toEqual([]);
  });

  it('stop_scope: done when a firm suppression is recorded after the analysis', async () => {
    const call = await analysed(
      lines(['Y', 'Hi, David from Callie.'], ['T', "Stop calling me. Don't contact anyone here again."]),
      answer({ stop: { requested: true, scope: 'all_contact', quote: 'Stop calling me', line: 2 } }),
    );
    expect(await kindsFor(call.sessionId)).toContain('stop_scope');
    const suppressed = await withTransaction(world.session, async () =>
      await recordSuppression(world.salesperson(), {
        scope: 'firm',
        firmId: call.firm.firmId,
        source: 'prospect_do_not_call',
        channel: 'all',
        commandId: `review-stop-${call.sessionId}`,
        journal: recordingSuppressionJournal(),
      }),
    );
    expect(suppressed.ok).toBe(true);
    expect(await kindsFor(call.sessionId)).not.toContain('stop_scope');
  });

  it('referral_contact: done when a contact with that name exists at the firm', async () => {
    const call = await analysed(
      lines(['Y', 'May I speak with Bob?'], ['T', 'Bob left. Talk to Sarah Kim.']),
      answer({ referral: { given: true, name: 'Sarah Kim', role: '', quote: 'Talk to Sarah Kim', line: 2 } }),
    );
    expect(await kindsFor(call.sessionId)).toEqual(['referral_contact']);
    await world.session.query("INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, '  sarah   kim ')", [
      world.seeded.alpha.workspaceId,
      call.firm.firmId,
    ]);
    expect(await kindsFor(call.sessionId)).toEqual([]);
  });

  it('callback_zone_unknown: done when the call has a callback', async () => {
    const call = await analysed(
      lines(['Y', 'Hi Dana, David from Callie.'], ['T', 'Call me back Thursday at 2pm.']),
      answer({
        callback: { requested: true, exact: true, phrase: 'Call me back Thursday at 2pm', line: 2, agreed_line: 0, day: 'thursday', date_text: 'Thursday', time: '2pm' },
      }),
      { timeZone: null },
    );
    expect(await kindsFor(call.sessionId)).toEqual(['callback_zone_unknown']);
    const logged = await log(call, 'callback_requested');
    if (!logged.ok) throw new Error(logged.reason);
    const scheduled = await withTransaction(world.session, async () =>
      await scheduleCallbackForCall(world.salesperson(), {
        callLogId: logged.value.callLogId,
        localDate: '2026-12-03',
        localTime: '14:00',
        sourceTimeZone: 'America/New_York',
      }),
    );
    expect(scheduled.ok, JSON.stringify(scheduled)).toBe(true);
    expect(await kindsFor(call.sessionId)).toEqual([]);
  });

  it('stop_with_email: done only on Dismiss, which is a decline', async () => {
    const call = await analysed(
      lines(['Y', 'Hi, David from Callie.'], ['T', 'Please stop calling me.'], ['T', 'Just send me an overview by email.']),
      answer({
        stop: { requested: true, scope: 'this_number', quote: 'Please stop calling me', line: 2 },
        follow_up_request: { kind: 'overview_email', quote: 'Just send me an overview by email', line: 3 },
      }),
    );
    expect(await kindsFor(call.sessionId)).toEqual(['stop_with_email']);
    expect((await dismiss(call, 'stop_with_email')).ok).toBe(true);
    expect(await kindsFor(call.sessionId)).toEqual([]);
  });

  it('follow_up_expired: an undecided follow_up more than seven days after the call', async () => {
    const call = await analysed(
      lines(['Y', 'Hi Dana, David from Callie.'], ['T', "Just send me an overview by email and I'll look at it."]),
      answer({ follow_up_request: { kind: 'overview_email', quote: 'Just send me an overview by email', line: 2 } }),
    );
    expect(await kindsFor(call.sessionId)).toEqual([]);
    await world.session.query("UPDATE call_sessions SET answered_at = now() - interval '8 days' WHERE id = $1", [call.sessionId]);
    expect(await kindsFor(call.sessionId)).toEqual(['follow_up_expired']);
    expect((await dismiss(call, 'follow_up')).ok).toBe(true);
    expect(await kindsFor(call.sessionId)).toEqual([]);
  });

  it('a stage item is listed, and resolved by id: resolved_at, resolved_by_user_id, audited', async () => {
    const firm = await world.newFirm();
    const { rows } = await world.session.query<{ id: string }>(
      `INSERT INTO stage_review_items (workspace_id, firm_id, evidence_kind, evidence_id, reason)
       VALUES ($1, $2, 'call.interested', $3, 'opportunity_closed') RETURNING id`,
      [world.seeded.alpha.workspaceId, firm.firmId, `test:${firm.firmId}`],
    );
    const itemId = rows[0]?.id ?? '';
    // Each item names its firm, so the list reads without a second request.
    const { rows: named } = await world.session.query<{ name: string }>('SELECT name FROM firms WHERE id = $1', [firm.firmId]);
    expect((await review()).find(item => item.source === 'stage' && item.itemId === itemId)).toMatchObject({
      firmId: firm.firmId,
      firmName: named[0]?.name,
    });
    const resolved = await withTransaction(world.session, async () => await resolveStageReviewItem(world.salesperson(), { itemId }));
    expect(resolved).toMatchObject({ ok: true, value: { itemId } });
    expect((await review()).some(item => item.source === 'stage' && item.itemId === itemId)).toBe(false);
    const { rows: stored } = await world.session.query<{ resolved_by_user_id: string; audits: string }>(
      `SELECT resolved_by_user_id,
              (SELECT count(*)::text FROM audit_events WHERE action = 'stage_review.resolved' AND subject_id = $2) AS audits
         FROM stage_review_items WHERE id = $1`,
      [itemId, itemId],
    );
    expect(stored[0]).toEqual({ resolved_by_user_id: world.seeded.alpha.salesperson.userId, audits: '1' });
    // Again: the same instant, no second audit row.
    expect(await withTransaction(world.session, async () => await resolveStageReviewItem(world.salesperson(), { itemId }))).toEqual(resolved);
  });

  it('B-7: a pending hold is listed after three hours open, whatever the facts, and leaves when released', async () => {
    await world.setTranscription(true);
    const firm = await world.newFirm();
    const placed = await world.placeCall(firm, lines(['Y', 'Hi.'], ['T', 'Hello.']), { transcript: false });
    await world.setTranscription(false);
    const listed = async () => (await review()).filter(item => item.source === 'pending_hold' && item.callSessionId === placed.sessionId);
    expect(await listed()).toEqual([]);
    // Three hours later — and the facts it was admitted on no longer hold (switch off).
    await world.session.query(
      "UPDATE active_holds SET started_at = now() - interval '3 hours 1 minute' WHERE source_event_kind = 'call_analysis_pending' AND source_event_id = $1",
      [placed.sessionId],
    );
    const { rows: named } = await world.session.query<{ name: string }>('SELECT name FROM firms WHERE id = $1', [firm.firmId]);
    expect(await listed()).toEqual([expect.objectContaining({ firmId: firm.firmId, firmName: named[0]?.name })]);
    expect(
      (
        await withTransaction(world.session, async () =>
          await logCallOutcome(world.salesperson(), {
            firmId: firm.firmId,
            callSessionId: placed.sessionId,
            outcome: 'interested',
            commandId: `review-hold-${placed.sessionId}`,
          }),
        )
      ).ok,
    ).toBe(true);
    expect(await listed()).toEqual([]);
  });
});
