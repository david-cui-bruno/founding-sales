import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallCorrectionEffect } from '@fss/contracts';
import { taskKey } from '../../calls/analysisPolicy.ts';
import { withTransaction } from '../../db/queryable.ts';
import { scheduleCallbackForCall } from '../../dial/callbacks.ts';
import { answer, lines } from './analysisFixtures.ts';
import { apply, createApplyWorld, type ApplyWorld } from './support/applyWorld.ts';
import { callbackFields, correct, logFormCall, logPlacedCall, placeSeries, preview } from './support/correctionWorld.ts';

/**
 * S3X contract check CC5 (DESIGN-S3X §5): every effect a correction must decide on is
 * findable from links that already exist, through the real writers.
 *
 *   * stops: `logCallOutcome` `do_not_call` with covers-all, and an Apply outcome
 *     `do_not_call`, found by `command_id = cmd||':handle' / ':firm'`; and a stop an earlier
 *     correction wrote (`no_answer → do_not_call`), found from its audit row (S3XD 2);
 *   * callbacks from all three creators (`logCallOutcome`, `scheduleCallbackForCall`, Apply's
 *     `createCallback`) by `call_log_id`; permissions by `call_log_id`; tasks by session;
 *   * parks at firm scope: four misses park under session 4, and the preview correcting
 *     session 3 to `interested` lists that park as conflicting (S3XD 6).
 */

const STOP_CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Please stop calling this number.']);
const STOP_READING = answer({
  summary: 'Dana asked not to be called again.',
  stop: { requested: true, scope: 'this_number', quote: 'Please stop calling this number.', line: 2 },
});
const PROMISE = 'I will send you the pricing sheet today';
const CALLBACK_CALL = lines(
  ['Y', 'Hi Dana, this is David from Callie.'],
  ['T', 'Can you show us a demo?'],
  ['Y', `Absolutely. ${PROMISE}.`],
  ['T', 'Call me back Thursday at 2.'],
);
const CALLBACK_READING = answer({
  summary: 'Dana asked for a demo and a callback Thursday at 2.',
  interest: { level: 'curious', signals: [] },
  commitments: [{ speaker: 'you', quote: PROMISE, line: 3, due_phrase: 'today' }],
  callback: { requested: true, exact: true, phrase: 'Call me back Thursday at 2', line: 4, agreed_line: 0, day: 'thursday', date_text: 'Thursday', time: '2' },
});

const conflicting = (effects: readonly CallCorrectionEffect[], kind: CallCorrectionEffect['kind']) =>
  effects.filter(effect => effect.kind === kind && effect.conflicts);

describe('CC5: every effect is found from existing links, through the real writers', () => {
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

  it('stops of logCallOutcome do_not_call with covers-all: the handle and the firm, by command id', async () => {
    const firm = await world.newFirm();
    const logId = await logFormCall(world, firm, 'do_not_call', { doNotCallCoversAllContact: true, commandId: 'cc5-dnc-form' });
    const shown = await preview(world, logId, 'interested');
    const stops = conflicting(shown.effects, 'stop');
    const { rows } = await world.session.query<{ event_id: string }>(
      "SELECT event_id FROM suppression_events WHERE command_id IN ('cc5-dnc-form:handle', 'cc5-dnc-form:firm') ORDER BY recorded_at, event_id",
    );
    expect(rows).toHaveLength(2);
    expect(stops.map(stop => stop.id).sort()).toEqual(rows.map(row => row.event_id).sort());
    expect(stops.map(stop => stop.facts.scope).sort()).toEqual(['firm', 'handle']);
    // A salesperson is offered Keep only (the follow-up lift is the admin supersession).
    expect(stops.every(stop => stop.decisions.join() === 'keep')).toBe(true);
    // An admin is offered both, and nothing is preselected (the server has no default).
    const asAdmin = await preview(world, logId, 'interested', world.admin()).catch((error: unknown) => String(error));
    expect(asAdmin).toBe('Error: preview: not_call_actor');
  });

  it('stops of an Apply outcome do_not_call, by command id', async () => {
    const firm = await world.newFirm();
    const call = await world.analyse(await world.placeCall(firm, STOP_CALL), STOP_READING);
    const applied = await apply(world, call, ['outcome'], { commandId: 'cc5-dnc-apply' });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    const logId = applied.ok ? applied.value.callLogId : null;
    expect(logId).not.toBeNull();
    const shown = await preview(world, logId ?? '', 'interested');
    const stops = conflicting(shown.effects, 'stop');
    const { rows } = await world.session.query<{ event_id: string }>("SELECT event_id FROM suppression_events WHERE command_id = 'cc5-dnc-apply:handle'");
    expect(stops.map(stop => stop.id)).toEqual(rows.map(row => row.event_id));
    expect(stops).toHaveLength(1);
    // Its provenance is the applied outcome, by exact id.
    expect(stops[0]?.appliedKey).toEqual({ analysisId: call.analysisId, key: 'outcome' });
    expect(shown.outcomeAppliedKey).toEqual({ analysisId: call.analysisId, key: 'outcome' });
  });

  it('S3XD 2: a stop an earlier correction wrote (no_answer → do_not_call) is listed by the next preview', async () => {
    const firm = await world.newFirm();
    const logId = await logFormCall(world, firm, 'no_answer');
    const first = await correct(world, logId, 'do_not_call');
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const written = first.ok ? first.value.applied.suppressionEventIds : [];
    expect(written).toHaveLength(1);
    const shown = await preview(world, logId, 'interested');
    expect(conflicting(shown.effects, 'stop').map(stop => stop.id)).toEqual(written);
  });

  it('callbacks from all three creators, by call_log_id', async () => {
    // 1. logCallOutcome with a confirmed time.
    const formFirm = await world.newFirm();
    const withTime = await logFormCall(world, formFirm, 'callback_requested', { callback: callbackFields() });
    // 2. scheduleCallbackForCall on a "call me back" logged without one.
    const scheduledFirm = await world.newFirm();
    const withoutTime = await logFormCall(world, scheduledFirm, 'callback_requested');
    const scheduled = await withTransaction(world.session, async () =>
      await scheduleCallbackForCall(world.salesperson(), { callLogId: withoutTime, ...callbackFields(10) }),
    );
    expect(scheduled.ok).toBe(true);
    // 3. Apply's createCallback, on a log whose outcome is not callback_requested.
    const applyFirm = await world.newFirm();
    const call = await world.analyse(await world.placeCall(applyFirm, CALLBACK_CALL), CALLBACK_READING);
    const appliedLog = await logPlacedCall(world, call, 'interested');
    const applied = await apply(world, call, ['callback']);
    expect(applied.ok, JSON.stringify(applied)).toBe(true);

    for (const [logId, target] of [
      [withTime, 'interested'],
      [withoutTime, 'interested'],
      [appliedLog, 'not_interested'],
    ] as const) {
      const { rows } = await world.session.query<{ id: string }>('SELECT id FROM callbacks WHERE call_log_id = $1', [logId]);
      expect(rows).toHaveLength(1);
      const shown = await preview(world, logId, target);
      expect(conflicting(shown.effects, 'callback').map(effect => effect.id)).toEqual([rows[0]?.id]);
    }
  });

  it('permissions by call_log_id, and tasks by the session', async () => {
    const firm = await world.newFirm();
    const permitted = await logFormCall(world, firm, 'interested', { followUpPermission: { scope: 'single_email', templateVersionId } });
    const { rows: permissions } = await world.session.query<{ id: string }>('SELECT id FROM follow_up_permissions WHERE call_log_id = $1', [permitted]);
    expect(permissions).toHaveLength(1);
    const shownPermission = await preview(world, permitted, 'no_answer');
    expect(conflicting(shownPermission.effects, 'permission').map(effect => [effect.id, effect.decisions])).toEqual([[permissions[0]?.id, ['undo']]]);
    // A reached outcome keeps the agreement: nothing to decide.
    expect(conflicting((await preview(world, permitted, 'not_interested')).effects, 'permission')).toEqual([]);

    const taskFirm = await world.newFirm();
    const call = await world.analyse(await world.placeCall(taskFirm, CALLBACK_CALL), CALLBACK_READING);
    const applied = await apply(world, call, ['outcome', taskKey(PROMISE)]);
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    const logId = applied.ok ? (applied.value.callLogId ?? '') : '';
    const { rows: tasks } = await world.session.query<{ id: string }>('SELECT id FROM call_tasks WHERE call_session_id = $1', [call.sessionId]);
    expect(tasks).toHaveLength(1);
    const shownTask = await preview(world, logId, 'no_answer');
    expect(conflicting(shownTask.effects, 'task').map(effect => effect.id)).toEqual([tasks[0]?.id]);
  });

  it('S3XD 6: four misses park the firm under session 4; correcting session 3 to interested lists that park as conflicting', async () => {
    const firm = await world.newFirm();
    const { calls, logIds } = await placeSeries(world, firm, ['no_answer', 'no_answer', 'no_answer', 'no_answer']);
    const { rows: parks } = await world.session.query<{ id: string; source_event_id: string }>(
      "SELECT id, source_event_id FROM active_holds WHERE scope_key = $1 AND source_event_kind = 'call_cadence_parked' AND released_at IS NULL",
      [firm.firmId],
    );
    expect(parks).toHaveLength(1);
    expect(parks[0]?.source_event_id).toBe(calls[3]?.sessionId);
    const shown = await preview(world, logIds[2] ?? '', 'interested');
    expect(conflicting(shown.effects, 'park').map(effect => effect.id)).toEqual([parks[0]?.id]);
    // Still unanswered: the park is still justified, so it does not conflict.
    const still = await preview(world, logIds[2] ?? '', 'busy');
    expect(still.effects.filter(effect => effect.kind === 'park').map(effect => effect.conflicts)).toEqual([false]);
  });
});
