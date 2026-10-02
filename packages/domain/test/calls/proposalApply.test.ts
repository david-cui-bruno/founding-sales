import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeCallAnalysis, createAnalysisVersion, readPolicyContext } from '../../calls/analysis.ts';
import { applyCallProposals } from '../../calls/proposalApply.ts';
import { taskKey } from '../../calls/analysisPolicy.ts';
import { resumeCallCadence } from '../../calls/sessions.ts';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { answer, lines } from './analysisFixtures.ts';
import { apply, refusedAt, createApplyWorld, pidOf, waitsOn, type Analysed, type ApplyWorld } from './support/applyWorld.ts';

/**
 * Slice 3a, lane B — check C3: a click applies only the newest completed analysis on the
 * current transcript, and only for the first time. Real PostgreSQL, the real apply handler
 * (`applyCallProposals`) and lane A's production writers (`createAnalysisVersion`,
 * `completeCallAnalysis`), the competing clicks on two connections.
 *
 *   * B-1: the check order — freshness first, then the first-time rules; a double click
 *     (same id, different id) is one log, one callback, one evidence row and one task; a
 *     second click with a different id meets `call_already_logged`, `callback_exists`,
 *     `already_parked` and `already_created`; `callback` alone with no log is
 *     `outcome_required`; one spoken promise is one task across shifted, split and merged
 *     lines.
 *   * B-2: freshness — v2 completed, then Apply v1, is `stale_analysis`; a new transcript
 *     revision is `stale_analysis`; a hash mismatch is `stale_proposal`.
 */

const PROMISE = 'I will send you the pricing sheet today';
const CALL = lines(
  ['Y', 'Hi Dana, this is David from Callie.'],
  ['T', "We're evaluating a couple of tools. Can you show us a demo?"],
  ['Y', `Absolutely. ${PROMISE}.`],
  ['T', 'Call me back Thursday at 2.'],
);
/** A buying signal, a callback with a day and a time, and a promise: four apply keys. */
const READING = answer({
  summary: 'You reached Dana. She is evaluating tools, asked for a demo and to be called back Thursday at 2.',
  interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
  commitments: [{ speaker: 'you', quote: PROMISE, line: 3, due_phrase: 'today' }],
  callback: {
    requested: true,
    exact: true,
    phrase: 'Call me back Thursday at 2',
    line: 4,
    agreed_line: 0,
    day: 'thursday',
    date_text: 'Thursday',
    time: '2',
  },
});
const SOFT_NO = lines(
  ['Y', 'Hi Dana, this is David from Callie.'],
  ['T', "We just signed with another vendor, so we're not looking right now."],
);
const SOFT_READING = answer({
  summary: 'You reached Dana. They have a solution and declined for now.',
  interest: { level: 'not_interested', signals: [] },
  objections: [{ category: 'has_solution', quote: 'We just signed with another vendor', line: 2, answered_line: 0 }],
});

describe('C3: first-time apply of the authoritative analysis', () => {
  let world: ApplyWorld;
  let other: SessionQueryable;
  let third: SessionQueryable;

  beforeAll(async () => {
    world = await createApplyWorld();
    other = await world.connection();
    third = await world.connection();
  });
  afterAll(async () => {
    await world.drop();
  });

  const count = async (sql: string, values: unknown[]): Promise<number> =>
    Number((await world.session.query<{ n: string }>(sql, values)).rows[0]?.n ?? 0);

  async function effectsOf(call: Analysed) {
    return {
      logs: await count(
        `SELECT count(*)::text AS n FROM call_logs l JOIN call_sessions s ON s.workspace_id = l.workspace_id AND s.ticket_id = l.ticket_id
          WHERE s.id = $1`,
        [call.sessionId],
      ),
      callbacks: await count(
        `SELECT count(*)::text AS n FROM callbacks c JOIN call_sessions s ON s.workspace_id = c.workspace_id AND s.call_log_id = c.call_log_id
          WHERE s.id = $1`,
        [call.sessionId],
      ),
      evidence: await count(
        "SELECT count(*)::text AS n FROM opportunity_stage_evidence WHERE firm_id = $1 AND evidence_kind = 'call.interested'",
        [call.firm.firmId],
      ),
      tasks: await count('SELECT count(*)::text AS n FROM call_tasks WHERE call_session_id = $1', [call.sessionId]),
    };
  }

  async function analysedCall(utterances = CALL, reading = READING): Promise<Analysed> {
    const firm = await world.newFirm();
    return await world.analyse(await world.placeCall(firm, utterances), reading);
  }

  it('proposes the four apply keys this test needs', async () => {
    const call = await analysedCall();
    expect([...call.keys].sort()).toEqual(['buying_signal', 'callback', 'outcome', taskKey(PROMISE)].sort());
  });

  for (const ids of ['the same command id', 'different command ids'] as const) {
    it(`B-1: a double click with ${ids} on two connections is one log, one callback, one evidence row and one task`, async () => {
      const call = await analysedCall();
      const keys = ['outcome', 'callback', 'buying_signal', taskKey(PROMISE)];
      const tag = ids === 'the same command id' ? 'same' : 'different';
      const first = `apply-double-${tag}-1`;
      const second = ids === 'the same command id' ? first : `apply-double-${tag}-2`;
      // The first click holds its transaction open on `other`; the second, on `third`, must
      // wait for it (observed, not inferred), then meets the first-time guard.
      await other.query('BEGIN');
      const held = await applyCallProposals(world.salesperson(other), {
        analysisId: call.analysisId,
        transcriptSha256: call.transcriptSha256,
        proposalHash: call.proposalHash,
        keys,
        commandId: first,
        journal: recordingSuppressionJournal(),
      });
      expect(held.ok).toBe(true);
      const blocker = await pidOf(other);
      const racing = apply(world, call, keys, { db: third, commandId: second });
      expect(await waitsOn(world.session, blocker)).toBe(true);
      await other.query('COMMIT');
      expect(await racing).toEqual(refusedAt('call_already_logged', 'outcome'));
      expect(await effectsOf(call)).toEqual({ logs: 1, callbacks: 1, evidence: 1, tasks: 1 });
      if (held.ok) {
        expect(held.value.results.map(entry => [entry.key, entry.result])).toEqual([
          ['outcome', 'applied'],
          ['callback', 'applied'],
          ['buying_signal', 'applied'],
          [taskKey(PROMISE), 'applied'],
        ]);
      }
    });
  }

  it('B-1: a second click with a different id meets each first-time guard, key by key', async () => {
    const call = await analysedCall();
    expect((await apply(world, call, ['outcome', 'callback', 'buying_signal', taskKey(PROMISE)])).ok).toBe(true);
    expect(await apply(world, call, ['outcome'])).toEqual(refusedAt('call_already_logged', 'outcome'));
    expect(await apply(world, call, ['callback'])).toEqual(refusedAt('callback_exists', 'callback'));
    const again = await apply(world, call, [taskKey(PROMISE)]);
    expect(again.ok && again.value.results).toEqual([
      expect.objectContaining({ key: taskKey(PROMISE), result: 'already_created' }),
    ]);
    // A repeated buying signal moves nothing: the evidence is one per call.
    const signal = await apply(world, call, ['buying_signal']);
    expect(signal.ok && signal.value.results).toEqual([expect.objectContaining({ key: 'buying_signal', result: 'already_applied' })]);
    expect(await effectsOf(call)).toEqual({ logs: 1, callbacks: 1, evidence: 1, tasks: 1 });

    // A park the analysis asked for, then again with a different id: `already_parked`.
    const soft = await analysedCall(SOFT_NO, SOFT_READING);
    expect([...soft.keys].sort()).toEqual(['outcome', 'park']);
    const parked = await apply(world, soft, ['outcome', 'park']);
    expect(parked.ok && parked.value.results.map(entry => entry.result)).toEqual(['applied', 'applied']);
    const twice = await apply(world, soft, ['park']);
    expect(twice.ok && twice.value.results).toEqual([expect.objectContaining({ key: 'park', result: 'already_parked' })]);
    expect(
      await count(
        "SELECT count(*)::text AS n FROM active_holds WHERE scope_key = $1 AND source_event_kind = 'call_cadence_parked' AND released_at IS NULL",
        [soft.firm.firmId],
      ),
    ).toBe(1);
  });

  it('B-1: a repeated buying signal at a firm whose opportunity was already open is already_applied, and measured once', async () => {
    const call = await world.analyse(await world.placeCall(await world.newFirm({ opportunity: 'open' }), CALL), READING);
    const first = await apply(world, call, ['buying_signal']);
    expect(first.ok && first.value.results).toEqual([expect.objectContaining({ key: 'buying_signal', result: 'applied' })]);
    const again = await apply(world, call, ['buying_signal'], { commandId: 'signal-again' });
    expect(again.ok && again.value.results).toEqual([expect.objectContaining({ key: 'buying_signal', result: 'already_applied' })]);
    expect(
      await count("SELECT count(*)::text AS n FROM audit_events WHERE action = 'call.proposal_decided' AND subject_id = $1", [call.analysisId]),
    ).toBe(1);
  });

  it('B-1: a park is already_parked when the automatic cadence park is open on the firm', async () => {
    const soft = await analysedCall(SOFT_NO, SOFT_READING);
    await world.session.query(
      `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, source_event_id, recovery_action)
       VALUES ($1, 'firm', $2, 'scoped_pause', ARRAY['dial_authorization'], 'call_cadence_parked', $3, 'resume_after_review')`,
      [world.seeded.alpha.workspaceId, soft.firm.firmId, soft.sessionId],
    );
    const parked = await apply(world, soft, ['park']);
    expect(parked.ok && parked.value.results).toEqual([expect.objectContaining({ key: 'park', result: 'already_parked' })]);
  });

  it('B-1: a park released by Resume stays released: the same proposal again is already_parked (review S3B, finding 7)', async () => {
    const soft = await analysedCall(SOFT_NO, SOFT_READING);
    const parked = await apply(world, soft, ['outcome', 'park']);
    expect(parked.ok, JSON.stringify(parked)).toBe(true);
    const resumed = await withTransaction(world.session, async () => await resumeCallCadence(world.salesperson(), { firmId: soft.firm.firmId }));
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    const again = await apply(world, soft, ['park'], { commandId: 'park-after-resume' });
    expect(again.ok && again.value.results).toEqual([expect.objectContaining({ key: 'park', result: 'already_parked' })]);
    expect(
      await count(
        "SELECT count(*)::text AS n FROM active_holds WHERE scope_key = $1 AND source_event_kind = 'call_cadence_parked' AND released_at IS NULL",
        [soft.firm.firmId],
      ),
    ).toBe(0);
  });

  it('B-1: callback (or follow_up) alone with no log is outcome_required, and nothing is written', async () => {
    const call = await analysedCall();
    expect(await apply(world, call, ['callback'])).toEqual(refusedAt('outcome_required', 'callback'));
    expect(await effectsOf(call)).toEqual({ logs: 0, callbacks: 0, evidence: 0, tasks: 0 });
  });

  it('B-1: freshness is checked before the first-time rules', async () => {
    const call = await analysedCall();
    expect((await apply(world, call, ['outcome'])).ok).toBe(true);
    // A logged call and a wrong hash: the hash answers, not the log.
    expect(await apply(world, call, ['outcome'], { proposalHash: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'stale_proposal' });
  });

  for (const change of ['shifted', 'split', 'merged'] as const) {
    it(`B-1: one spoken promise is one task after the transcript's lines are ${change}`, async () => {
      const call = await analysedCall();
      const applied = await apply(world, call, [taskKey(PROMISE)]);
      expect(applied.ok).toBe(true);
      const revised =
        change === 'shifted'
          ? lines(['T', 'Hello?'], ...CALL.map(line => [line.speaker === 0 ? 'Y' : 'T', line.text] as ['Y' | 'T', string]))
          : change === 'split'
            ? lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', CALL[1]?.text ?? ''], ['Y', 'Absolutely.'], ['Y', `${PROMISE}.`], ['T', CALL[3]?.text ?? ''])
            : lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', CALL[1]?.text ?? ''], ['Y', `Absolutely. ${PROMISE}. Talk soon.`], ['T', CALL[3]?.text ?? '']);
      await world.session.query('UPDATE call_transcripts SET utterances = $2::jsonb WHERE call_session_id = $1', [
        call.sessionId,
        JSON.stringify(revised),
      ]);
      const promiseLine = revised.findIndex(line => line.text.includes(PROMISE)) + 1;
      const signalLine = revised.findIndex(line => line.text.includes('show us a demo')) + 1;
      const callbackLine = revised.findIndex(line => line.text.includes('Thursday at 2')) + 1;
      const reread = answer({
        summary: 'You reached Dana again.',
        interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: signalLine }] },
        commitments: [{ speaker: 'you', quote: PROMISE, line: promiseLine, due_phrase: 'today' }],
        callback: { requested: true, exact: true, phrase: 'Call me back Thursday at 2', line: callbackLine, agreed_line: 0, day: 'thursday', date_text: 'Thursday', time: '2' },
      });
      const v2 = await withTransaction(world.session, async () =>
        await createAnalysisVersion(world.system(), { sessionId: call.sessionId, origin: 'model', reason: 'reanalysis', model: 'claude-haiku-4-5-20251001' }),
      );
      if (v2.kind !== 'created') throw new Error(v2.kind);
      await withTransaction(world.session, async () => {
        const policyContext = await readPolicyContext(world.system(), call.sessionId);
        if (policyContext === null) throw new Error('no policy context');
        return await completeCallAnalysis(world.system(), { analysisId: v2.analysisId, rawAnswer: reread, utterances: revised, policyContext });
      });
      const shown = (await world.read(call.sessionId)).authoritative;
      expect(shown?.analysisId).toBe(v2.analysisId);
      expect(shown?.proposals.map(proposal => proposal.key)).toContain(taskKey(PROMISE));
      const again = await apply(world, { ...call, analysisId: v2.analysisId, transcriptSha256: shown?.transcriptSha256 ?? '', proposalHash: shown?.proposalHash ?? '' }, [taskKey(PROMISE)]);
      expect(again.ok && again.value.results).toEqual([expect.objectContaining({ result: 'already_created' })]);
      expect(await count('SELECT count(*)::text AS n FROM call_tasks WHERE call_session_id = $1', [call.sessionId])).toBe(1);
    });
  }

  // ---------------------------------------------------------------------------- B-2

  it('B-2: v2 completed through completeCallAnalysis, then Apply v1, is stale_analysis', async () => {
    const call = await analysedCall();
    const v2 = await withTransaction(world.session, async () =>
      await createAnalysisVersion(world.system(), { sessionId: call.sessionId, origin: 'model', reason: 'reanalysis', model: 'claude-haiku-4-5-20251001' }),
    );
    if (v2.kind !== 'created') throw new Error(v2.kind);
    // Pending v2 does not stale v1: only a completed version is authoritative.
    expect(await apply(world, call, [taskKey(PROMISE)], { commandId: 'b2-pending' })).toMatchObject({ ok: true });
    await withTransaction(world.session, async () => {
      const policyContext = await readPolicyContext(world.system(), call.sessionId);
      if (policyContext === null) throw new Error('no policy context');
      return await completeCallAnalysis(world.system(), { analysisId: v2.analysisId, rawAnswer: READING, utterances: CALL, policyContext });
    });
    expect(await apply(world, call, ['outcome'])).toEqual({ ok: false, reason: 'stale_analysis' });
    expect(await effectsOf(call)).toMatchObject({ logs: 0 });
  });

  for (const first of ['completion', 'apply'] as const) {
    it(`B-2: v2's completion racing an Apply of v1 (${first} first) — the second waits, and v1 applies only before v2 completes`, async () => {
      const call = await analysedCall();
      const v2 = await withTransaction(world.session, async () =>
        await createAnalysisVersion(world.system(), { sessionId: call.sessionId, origin: 'model', reason: 'reanalysis', model: 'claude-haiku-4-5-20251001' }),
      );
      if (v2.kind !== 'created') throw new Error(v2.kind);
      await other.query('BEGIN');
      if (first === 'completion') {
        const policyContext = await readPolicyContext(world.system(other), call.sessionId);
        if (policyContext === null) throw new Error('no policy context');
        await completeCallAnalysis(world.system(other), { analysisId: v2.analysisId, rawAnswer: READING, utterances: CALL, policyContext });
      } else {
        const held = await applyCallProposals(world.salesperson(other), {
          analysisId: call.analysisId,
          transcriptSha256: call.transcriptSha256,
          proposalHash: call.proposalHash,
          keys: ['outcome'],
          commandId: `race-${first}`,
          journal: recordingSuppressionJournal(),
        });
        expect(held.ok).toBe(true);
      }
      const blocker = await pidOf(other);
      const second =
        first === 'completion'
          ? apply(world, call, ['outcome'], { db: third })
          : withTransaction(third, async () => {
              const policyContext = await readPolicyContext(world.system(third), call.sessionId);
              if (policyContext === null) throw new Error('no policy context');
              return await completeCallAnalysis(world.system(third), { analysisId: v2.analysisId, rawAnswer: READING, utterances: CALL, policyContext });
            });
      expect(await waitsOn(world.session, blocker)).toBe(true);
      await other.query('COMMIT');
      const answer2 = await second;
      if (first === 'completion') expect(answer2).toEqual({ ok: false, reason: 'stale_analysis' });
      else expect(answer2).toMatchObject({ kind: 'completed' });
      expect((await effectsOf(call)).logs).toBe(first === 'completion' ? 0 : 1);
    });
  }

  it('B-2: a new transcript revision is stale_analysis, and so is an echoed transcript hash that is not the current one', async () => {
    const call = await analysedCall();
    expect(await apply(world, call, ['outcome'], { transcriptSha256: 'e'.repeat(64) })).toEqual({ ok: false, reason: 'stale_analysis' });
    await world.session.query('UPDATE call_transcripts SET utterances = $2::jsonb WHERE call_session_id = $1', [
      call.sessionId,
      JSON.stringify([...CALL, { speaker: 1, start: 30, end: 33, text: 'Thanks, bye.' }]),
    ]);
    expect(await apply(world, call, ['outcome'])).toEqual({ ok: false, reason: 'stale_analysis' });
  });

  it('B-2: a hash that is not the stored one is stale_proposal, and an unknown or review key is proposal_unknown', async () => {
    const call = await analysedCall();
    expect(await apply(world, call, ['outcome'], { proposalHash: '0'.repeat(64) })).toEqual({ ok: false, reason: 'stale_proposal' });
    expect(await apply(world, call, ['park'])).toEqual(refusedAt('proposal_unknown', 'park'));
    expect(await effectsOf(call)).toEqual({ logs: 0, callbacks: 0, evidence: 0, tasks: 0 });
  });

  it('a review-mode proposal is never applied: an unconfirmed buying signal is proposal_unknown, and nothing is written', async () => {
    const vague = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Hm, that sounds pretty neat.']);
    const call = await analysedCall(
      vague,
      answer({ interest: { level: 'buying_signal', signals: [{ kind: 'evaluation', quote: 'that sounds pretty neat', line: 2 }] } }),
    );
    const shown = (await world.read(call.sessionId)).authoritative?.proposals ?? [];
    expect(shown.find(proposal => proposal.key === 'buying_signal')?.mode).toBe('review');
    expect(await apply(world, call, ['buying_signal'])).toEqual(refusedAt('proposal_unknown', 'buying_signal'));
    expect(await effectsOf(call)).toEqual({ logs: 0, callbacks: 0, evidence: 0, tasks: 0 });
  });

  it('B-8: stop plus e-mail stays in review — no follow_up key to apply, and none is accepted', async () => {
    // A confirmed stop (its own line, a known form) with an e-mail request on the next line:
    // the stop applies, the request is David's to read.
    const stopMail = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Please stop calling me.'], ['T', 'Just send me an overview by email.']);
    const call = await analysedCall(
      stopMail,
      answer({
        summary: 'Dana asked not to be called and to be e-mailed an overview.',
        stop: { requested: true, scope: 'this_number', quote: 'Please stop calling me', line: 2 },
        follow_up_request: { kind: 'overview_email', quote: 'Just send me an overview by email', line: 3 },
      }),
    );
    const shown = (await world.read(call.sessionId)).authoritative?.proposals ?? [];
    expect(shown.find(proposal => proposal.key === 'stop_with_email')?.mode).toBe('review');
    expect(shown.some(proposal => proposal.kind === 'follow_up')).toBe(false);
    expect(await apply(world, call, ['outcome', 'follow_up'], { edits: { follow_up: { templateVersionId: '00000000-0000-4000-8000-000000000001' } } })).toEqual(
      refusedAt('proposal_unknown', 'follow_up'),
    );
  });

  // ---------------------------------------------------------------------------- B-5

  describe('B-5: the buying signal, in either click order, leaves the opportunity manual', () => {
    const SIGNAL_CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', "We're evaluating tools. Can you show us a demo?"]);
    const SIGNAL = answer({
      summary: 'You reached Dana. She asked for a demo.',
      interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
    });
    const opportunityOf = async (firmId: string) =>
      (
        await world.session.query<{ status: string; control_mode: string; control_mode_origin: string | null }>(
          "SELECT status, control_mode, control_mode_origin FROM opportunities WHERE firm_id = $1 AND status = 'open'",
          [firmId],
        )
      ).rows;

    for (const order of [['outcome', 'buying_signal'], ['buying_signal', 'outcome'], ['outcome+buying_signal']] as const) {
      it(`${order.join(' then ')}, at a firm with no opportunity`, async () => {
        const firm = await world.newFirm();
        const call = await world.analyse(await world.placeCall(firm, SIGNAL_CALL), SIGNAL);
        expect([...call.keys].sort()).toEqual(['buying_signal', 'outcome']);
        for (const step of order) {
          const applied = await apply(world, call, step.split('+'));
          expect(applied.ok, JSON.stringify(applied)).toBe(true);
        }
        expect(await opportunityOf(firm.firmId)).toEqual([{ status: 'open', control_mode: 'manual', control_mode_origin: 'engaged_call' }]);
      });
    }

    it('an open automated opportunity becomes manual on the tick alone, and no second opportunity is opened', async () => {
      const firm = await world.newFirm({ opportunity: 'open' });
      const call = await world.analyse(await world.placeCall(firm, SIGNAL_CALL), SIGNAL);
      expect((await apply(world, call, ['buying_signal'])).ok).toBe(true);
      expect(await opportunityOf(firm.firmId)).toEqual([{ status: 'open', control_mode: 'manual', control_mode_origin: 'engaged_call' }]);
    });

    it('a firm whose history is closed gets a review item, never a reopened deal', async () => {
      const firm = await world.newFirm({ opportunity: 'closed' });
      const call = await world.analyse(await world.placeCall(firm, SIGNAL_CALL), SIGNAL);
      const applied = await apply(world, call, ['buying_signal']);
      expect(applied.ok && applied.value.results).toEqual([expect.objectContaining({ key: 'buying_signal', id: null })]);
      expect(await opportunityOf(firm.firmId)).toEqual([]);
      expect(
        await count("SELECT count(*)::text AS n FROM stage_review_items WHERE firm_id = $1 AND reason = 'opportunity_closed'", [firm.firmId]),
      ).toBe(1);
    });

    it('without the tick, no deal is opened: the outcome alone opens nothing', async () => {
      const firm = await world.newFirm();
      const call = await world.analyse(await world.placeCall(firm, SIGNAL_CALL), SIGNAL);
      expect((await apply(world, call, ['outcome'])).ok).toBe(true);
      expect(await opportunityOf(firm.firmId)).toEqual([]);
    });
  });
});
