import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readNeedsReview } from '../../calls/needsReview.ts';
import { withTransaction } from '../../db/queryable.ts';
import { confirmCapturedFollowUp, logCallOutcome, recordCallFollowUp } from '../../dial/calls.ts';
import { taskKey } from '../../calls/analysisPolicy.ts';
import { verifyFollowUpPermission } from '../../sequences/followUpPermissions.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { answer, lines } from './analysisFixtures.ts';
import { apply, createApplyWorld, refusedAt, type Analysed, type ApplyWorld, type PlacedCall, type TestFirm } from './support/applyWorld.ts';

/**
 * Slice 3a, lane B — B-14: the captured overview confirmation (David's decision 7).
 *
 * "Can you send me an overview?" is a verified `follow_up` proposal. Selected on a call that
 * is already logged, the Apply records it through `confirmCapturedFollowUp` — seven days from
 * the call's `occurred_at`, read with `clock_timestamp()` after the locks — beside
 * `recordCallFollowUp`, whose sixty-minute window is unchanged:
 *
 *   * 61 minutes after the call: the agreement, the single-e-mail grant (which verifies for
 *     the same person and template) and the "Send overview" task — at a firm with no
 *     opportunity too;
 *   * 8 days after: `follow_up_expired`, nothing written, and the request in Needs review;
 *   * `recordCallFollowUp` on the same 61-minute-old call: still `call_too_old`;
 *   * no verified `follow_up` proposal on the analysis: refused.
 *
 * And the S3B review round: the window is the CALL's (a late manual log of an 8-day-old call
 * is still expired, finding 3); a follow-up whose permission is not granted refuses the whole
 * Apply, atomically (finding 4); the overview task is written once, with David's edits, in
 * either key order (finding 5).
 */

const OVERVIEW_CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Sounds good. Could you send me an overview by email?']);
const OVERVIEW = answer({
  summary: 'You reached Dana. She asked for an overview by e-mail.',
  interest: { level: 'curious', signals: [] },
  follow_up_request: { kind: 'overview_email', quote: 'Could you send me an overview by email?', line: 2 },
});
const NO_REQUEST_CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Sounds useful, tell me more.']);
const NO_REQUEST = answer({ summary: 'You reached Dana. She wanted to hear more.', interest: { level: 'curious', signals: [] } });

describe('B-14: the captured overview confirmation', () => {
  let world: ApplyWorld;
  let templateVersionId: string;

  beforeAll(async () => {
    world = await createApplyWorld();
    const { rows } = await world.session.query<{ id: string }>(
      `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body,
                                      content_hash, footer_sign_off, approved_at, approved_by_user_id)
       SELECT w.workspace_id, gen_random_uuid(), 1, 'The overview', 'A question about {firm_name}',
              'Hello {contact_first_name}.', encode(sha256(random()::text::bytea), 'hex'), 'Sam Example', now(), w.user_id
         FROM workspace_memberships w
        WHERE w.workspace_id = (SELECT workspace_id FROM firms WHERE id = $1) AND w.role = 'admin'
        LIMIT 1
       RETURNING id`,
      [(await world.newFirm()).firmId],
    );
    templateVersionId = rows[0]?.id ?? '';
    expect(templateVersionId).not.toBe('');
  });
  afterAll(async () => {
    await world.drop();
  });

  /** Move the whole call back in time, every instant together, so its rows stay consistent. */
  async function age(call: PlacedCall, interval: string): Promise<void> {
    await world.session.query(
      `UPDATE call_sessions
          SET created_at = created_at - $2::interval, expires_at = expires_at - $2::interval,
              consumed_at = consumed_at - $2::interval, started_at = started_at - $2::interval,
              answered_at = answered_at - $2::interval, ended_at = ended_at - $2::interval
        WHERE id = $1`,
      [call.sessionId, interval],
    );
  }
  const startOf = async (call: PlacedCall): Promise<string> =>
    (
      await world.session.query<{ started: Date }>(
        'SELECT coalesce(answered_at, started_at, created_at) AS started FROM call_sessions WHERE id = $1',
        [call.sessionId],
      )
    ).rows[0]?.started.toISOString() ?? '';

  /** The call, aged; logged by the form at the time it happened; then analysed. */
  async function loggedCall(firm: TestFirm, interval: string, utterances = OVERVIEW_CALL, reading = OVERVIEW): Promise<Analysed & { callLogId: string }> {
    const call = await world.placeCall(firm, utterances);
    await age(call, interval);
    const logged = await withTransaction(world.session, async () =>
      await logCallOutcome(world.salesperson(), {
        firmId: firm.firmId,
        contactId: firm.contactId,
        callSessionId: call.sessionId,
        outcome: 'interested',
        occurredAt: await startOf(call),
        commandId: `b14-form-${call.sessionId}`,
        journal: recordingSuppressionJournal(),
      }),
    );
    if (!logged.ok) throw new Error(`the form refused: ${logged.reason}`);
    return { ...(await world.analyse(call, reading)), callLogId: logged.value.callLogId };
  }
  const edits = () => ({ follow_up: { templateVersionId } });
  const effects = async (call: Analysed & { callLogId: string }) => ({
    agreed: (
      await world.session.query<{ agreed: string | null }>('SELECT agreed_follow_up AS agreed FROM call_logs WHERE id = $1', [call.callLogId])
    ).rows[0]?.agreed,
    permissions: (
      await world.session.query<{ id: string }>('SELECT id FROM follow_up_permissions WHERE call_log_id = $1', [call.callLogId])
    ).rows.map(row => row.id),
    tasks: (
      await world.session.query<{ text: string; status: string }>('SELECT text, status FROM call_tasks WHERE call_session_id = $1', [call.sessionId])
    ).rows,
  });

  it('61 minutes after the call: the agreement, a grant that verifies for the same person, and the "Send overview" task — with no opportunity', async () => {
    const firm = await world.newFirm({ opportunity: 'none' });
    const call = await loggedCall(firm, '61 minutes');
    expect(call.keys).toContain('follow_up');
    const result = await apply(world, call, ['follow_up'], { edits: edits() });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const followUp = result.value.results.find(entry => entry.key === 'follow_up');
    expect(followUp).toMatchObject({ result: 'applied' });

    const after = await effects(call);
    expect(after.agreed).toBe('single_email');
    expect(after.permissions).toHaveLength(1);
    expect(after.tasks).toEqual([{ text: 'Send overview to Dana Example', status: 'open' }]);
    const { rows: clock } = await world.session.query<{ now: Date }>('SELECT now() AS now');
    expect(
      await verifyFollowUpPermission(world.system(), after.permissions[0] ?? '', {
        firmId: firm.firmId,
        contactId: firm.contactId,
        now: (clock[0]?.now ?? new Date()).toISOString(),
        templateVersionId,
      }),
    ).toMatchObject({ ok: true });
    const { rows: audit } = await world.session.query('SELECT 1 FROM audit_events WHERE action = $1 AND subject_id = $2', [
      'call.follow_up_confirmed',
      call.callLogId,
    ]);
    expect(audit).toHaveLength(1);
  });

  it("recordCallFollowUp's sixty minutes are unchanged: the same 61-minute-old call is call_too_old", async () => {
    const call = await loggedCall(await world.newFirm(), '61 minutes');
    const recorded = await withTransaction(world.session, async () =>
      await recordCallFollowUp(world.salesperson(), {
        callLogId: call.callLogId,
        followUpPermission: { scope: 'single_email', templateVersionId },
      }),
    );
    expect(recorded).toEqual({ ok: false, reason: 'call_too_old' });
    expect(await effects(call)).toEqual({ agreed: null, permissions: [], tasks: [] });
  });

  it('8 days after: follow_up_expired, nothing written, and the request in Needs review', async () => {
    const call = await loggedCall(await world.newFirm(), '8 days');
    expect(await apply(world, call, ['follow_up'], { edits: edits() })).toEqual(refusedAt('follow_up_expired', 'follow_up'));
    expect(await effects(call)).toEqual({ agreed: null, permissions: [], tasks: [] });
    const review = await readNeedsReview(world.salesperson());
    expect(review.items).toContainEqual(
      expect.objectContaining({ source: 'proposal', reviewKind: 'follow_up_expired', analysisId: call.analysisId, callSessionId: call.sessionId }),
    );

    // A first-time Apply of the same request eight days on is refused the same way.
    const unlogged = await world.placeCall(await world.newFirm(), OVERVIEW_CALL);
    await age(unlogged, '8 days');
    const shown = await world.analyse(unlogged, OVERVIEW);
    expect(await apply(world, shown, ['outcome', 'follow_up'], { edits: edits() })).toEqual(refusedAt('follow_up_expired', 'follow_up'));
    const { rows: logs } = await world.session.query('SELECT 1 FROM call_sessions WHERE id = $1 AND call_log_id IS NOT NULL', [unlogged.sessionId]);
    expect(logs).toHaveLength(0);
  });

  it('no verified follow_up proposal on the analysis: refused, nothing written', async () => {
    const call = await loggedCall(await world.newFirm(), '61 minutes', NO_REQUEST_CALL, NO_REQUEST);
    expect(call.keys).not.toContain('follow_up');
    expect(await apply(world, call, ['follow_up'], { edits: edits() })).toEqual(refusedAt('proposal_unknown', 'follow_up'));
    expect(await effects(call)).toEqual({ agreed: null, permissions: [], tasks: [] });
  });

  it('a late manual log of an 8-day-old call does not reopen the window: follow_up_expired, in the Apply and in confirmCapturedFollowUp', async () => {
    const firm = await world.newFirm();
    const call = await world.placeCall(firm, OVERVIEW_CALL);
    await age(call, '8 days');
    // The form today, with no time entered: the log says now.
    const logged = await withTransaction(world.session, async () =>
      await logCallOutcome(world.salesperson(), {
        firmId: firm.firmId,
        contactId: firm.contactId,
        callSessionId: call.sessionId,
        outcome: 'interested',
        commandId: `b14-late-${call.sessionId}`,
        journal: recordingSuppressionJournal(),
      }),
    );
    if (!logged.ok) throw new Error(logged.reason);
    const shown = { ...(await world.analyse(call, OVERVIEW)), callLogId: logged.value.callLogId };
    expect(await apply(world, shown, ['follow_up'], { edits: edits() })).toEqual(refusedAt('follow_up_expired', 'follow_up'));
    expect(
      await withTransaction(world.session, async () =>
        await confirmCapturedFollowUp(world.salesperson(), { callLogId: shown.callLogId, templateVersionId, commandId: `late-${call.sessionId}` }),
      ),
    ).toEqual({ ok: false, reason: 'follow_up_expired' });
    expect(await effects(shown)).toEqual({ agreed: null, permissions: [], tasks: [] });
    // Needs review reads the same clock: the request is expired there too.
    const review = await readNeedsReview(world.salesperson());
    expect(review.items).toContainEqual(expect.objectContaining({ reviewKind: 'follow_up_expired', callSessionId: call.sessionId }));
  });

  it('a follow-up whose permission is not granted refuses the whole Apply: nothing logged, no task, nothing measured', async () => {
    const { rows } = await world.session.query<{ id: string }>(
      `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body,
                                      content_hash, footer_sign_off, approved_at, approved_by_user_id, retired_at)
       SELECT workspace_id, gen_random_uuid(), 1, 'The old overview', 'A question about {firm_name}', 'Hello.',
              encode(sha256(random()::text::bytea), 'hex'), 'Sam Example', now() - interval '1 day', approved_by_user_id, now()
         FROM template_versions WHERE id = $1
       RETURNING id`,
      [templateVersionId],
    );
    const retired = { follow_up: { templateVersionId: rows[0]?.id ?? '' } };
    const decisions = async (analysisId: string) =>
      (await world.session.query("SELECT 1 FROM audit_events WHERE action = 'call.proposal_decided' AND subject_id = $1", [analysisId])).rows.length;

    // First time: outcome, follow-up and its task, in one `logCallOutcome`.
    const fresh = await world.analyse(await world.placeCall(await world.newFirm(), OVERVIEW_CALL), OVERVIEW);
    const overviewKey = taskKey('Could you send me an overview by email?');
    expect(fresh.keys).toEqual(expect.arrayContaining(['outcome', 'follow_up', overviewKey]));
    expect(await apply(world, fresh, ['outcome', 'follow_up', overviewKey], { edits: retired })).toEqual(
      refusedAt('follow_up_not_granted', 'follow_up', 'template_retired'),
    );
    const { rows: logs } = await world.session.query('SELECT 1 FROM call_sessions WHERE id = $1 AND call_log_id IS NOT NULL', [fresh.sessionId]);
    expect(logs).toHaveLength(0);
    expect((await world.session.query('SELECT 1 FROM call_tasks WHERE call_session_id = $1', [fresh.sessionId])).rows).toHaveLength(0);
    expect(await decisions(fresh.analysisId)).toBe(0);

    // On a logged call: `confirmCapturedFollowUp`'s path, the same refusal.
    const logged = await loggedCall(await world.newFirm(), '61 minutes');
    expect(await apply(world, logged, ['follow_up'], { edits: retired })).toEqual(refusedAt('follow_up_not_granted', 'follow_up', 'template_retired'));
    expect(await effects(logged)).toEqual({ agreed: null, permissions: [], tasks: [] });
    expect(await decisions(logged.analysisId)).toBe(0);
  });

  for (const order of ['follow_up first', 'the task first'] as const) {
    it(`the overview task is written once, with David's edits, when ${order}`, async () => {
      const call = await world.analyse(await world.placeCall(await world.newFirm(), OVERVIEW_CALL), OVERVIEW);
      const overviewKey = taskKey('Could you send me an overview by email?');
      const keys = order === 'follow_up first' ? ['outcome', 'follow_up', overviewKey] : ['outcome', overviewKey, 'follow_up'];
      const dueAt = '2026-10-06T14:00:00.000Z';
      const result = await apply(world, call, keys, {
        edits: { ...edits(), tasks: { [overviewKey]: { text: 'Send Dana the one-pager', dueAt } } },
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.results.find(entry => entry.key === overviewKey)).toMatchObject({ result: 'applied', edited: true });
      const { rows: tasks } = await world.session.query<{ text: string; due_at: Date }>(
        'SELECT text, due_at FROM call_tasks WHERE call_session_id = $1',
        [call.sessionId],
      );
      expect(tasks.map(task => [task.text, task.due_at.toISOString()])).toEqual([['Send Dana the one-pager', dueAt]]);
    });
  }
});
