import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callAnalysisLockKey } from '../../calls/analysis.ts';
import { recordCallRecording, recordCallStatus } from '../../calls/sessions.ts';
import { updateFirmBasics } from '../../crm/firmBasics.ts';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { lockSendGateForStopFact } from '../../policy/sendGate.ts';
import { recordSuppression } from '../../suppression/events.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { buildTodaySnapshot } from '../../today/build.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import { answer, lines } from './analysisFixtures.ts';
import { apply, createApplyWorld, refusedAt, pidOf, waitsOn, type Analysed, type ApplyWorld } from './support/applyWorld.ts';

/**
 * Slice 3a, lane B — check C4 (B-3): the apply transaction cannot deadlock. Real
 * PostgreSQL, two connections (three where one holds a lock to stop the Apply half-way).
 *
 * The apply's order is Today's lock (shared) → the send gate → the dialled route (a
 * wrong-number or stop outcome) → the firm → `call_analysis:<session>` → the session row.
 * Each competitor below is run against it in both orders, and once more with the Apply
 * stopped half-way — holding Today, the gate, the route and the firm, waiting for the
 * analysis lock a third connection holds — while the competitor starts and blocks on it.
 * That interleaving is the one that deadlocks when a competitor takes a lock the Apply
 * still needs before one the Apply already holds; every pair here must finish instead.
 *
 * Competitors: the status callback (a repeated terminal delivery that may admit the
 * pending hold), the recording callback, the morning build, `updateFirmBasics` replacing
 * the dialled number, David's own `logCallOutcome` for the same call, a reply opt-out's
 * suppression writes, and `completeCallAnalysis` (in `proposalApply.test.ts`, B-2).
 */

const CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Sure. Can you show us a demo?']);
const INTERESTED = answer({
  summary: 'You reached Dana. She asked for a demo.',
  interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
});
const WRONG = lines(['Y', 'Hi, is this Northwind?'], ['T', 'No, wrong number, this is a private line.']);
const WRONG_READING = answer({
  summary: 'A wrong number.',
  wrong_number: { is_wrong: true, quote: 'wrong number, this is a private line', line: 2, other_number_given: '' },
});

/**
 * `basics` replaces the dialled number under a wrong-number Apply (which retires it);
 * `basicsOrdinary` under an ordinary `interested` Apply, whose call-log insert takes the
 * route's foreign-key lock (review S3B, finding 1).
 */
type Competitor = 'status' | 'recording' | 'build' | 'basics' | 'basicsOrdinary' | 'logOutcome' | 'optOut';

describe('C4 (B-3): the apply against every competitor, in both orders and stopped half-way', () => {
  let world: ApplyWorld;
  let a: SessionQueryable;
  let b: SessionQueryable;
  let blocker: SessionQueryable;
  let numbers = 0;

  beforeAll(async () => {
    world = await createApplyWorld();
    a = await world.connection();
    b = await world.connection();
    blocker = await world.connection();
  });
  afterAll(async () => {
    await world.drop();
  });

  async function isBlocked(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const { rows } = await world.session.query<{ blocked: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
        [pid],
      );
      if (rows[0]?.blocked === true) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  }

  /** A call for the competitor: placed with transcription off, so no pending hold exists yet. */
  async function prepare(competitor: Competitor): Promise<{ readonly call: Analysed; readonly keys: readonly string[] }> {
    await world.setTranscription(false);
    const firm = await world.newFirm();
    const wrong = competitor === 'basics';
    const call = await world.analyse(await world.placeCall(firm, wrong ? WRONG : CALL), wrong ? WRONG_READING : INTERESTED);
    // From here a delivery would admit the hold: the competitor callbacks take the gate.
    await world.setTranscription(true);
    // No Today task for the firm yet, so the morning build has one to insert under the firm's key.
    await world.session.query('DELETE FROM today_items WHERE firm_id = $1', [firm.firmId]);
    return { call, keys: wrong ? ['outcome'] : ['outcome', 'buying_signal'] };
  }

  /** The competitor's work on `db`, inside whatever transaction the caller opened. */
  async function work(competitor: Competitor, call: Analysed, db: SessionQueryable): Promise<unknown> {
    switch (competitor) {
      case 'status':
        return await recordCallStatus(db, { callSid: call.callSid, providerStatus: 'completed', durationSeconds: 125 });
      case 'recording':
        return await recordCallRecording(db, {
          callSid: call.callSid,
          recordingSid: `RE${'b'.repeat(32)}`,
          recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/RE${'b'.repeat(32)}`,
          durationSeconds: 125,
        });
      case 'build': {
        const now = (await db.query<{ now: Date }>('SELECT now() AS now')).rows[0]?.now.toISOString() ?? '';
        return await buildTodaySnapshot(world.system(db), { businessDate: await businessDateOf(world.system(db), now), now });
      }
      case 'basics':
      case 'basicsOrdinary':
        numbers += 1;
        return await updateFirmBasics(world.salesperson(db), {
          firmId: call.firm.firmId,
          phone: { number: `+1401555${String(7000 + numbers)}`, replacesRouteId: call.firm.routeId },
        });
      case 'logOutcome':
        return await logCallOutcome(world.salesperson(db), {
          firmId: call.firm.firmId,
          callSessionId: call.sessionId,
          outcome: 'interested',
          commandId: `form-${call.sessionId}`,
          journal: recordingSuppressionJournal(),
        });
      case 'optOut': {
        // A reply opt-out's writes, in its order (`applyClassificationEffects`): the gate,
        // then the handle suppression, then the firm's (which locks the firm row).
        const system = world.system(db);
        await lockSendGateForStopFact(system);
        const handle = await recordSuppression(system, {
          scope: 'handle',
          value: `dana-${call.sessionId.slice(0, 8)}@example.test`,
          source: 'prospect_opt_out',
          channel: 'all',
          commandId: `mail-message:${call.sessionId}`,
          journal: recordingSuppressionJournal(),
        });
        const firm = await recordSuppression(system, {
          scope: 'firm',
          firmId: call.firm.firmId,
          source: 'prospect_opt_out',
          channel: 'all',
          commandId: `mail-message:${call.sessionId}:firm`,
          journal: recordingSuppressionJournal(),
        });
        return { handle: handle.ok, firm: firm.ok };
      }
    }
  }

  /** The competitor in its own transaction on `db`. */
  const run = async (competitor: Competitor, call: Analysed, db: SessionQueryable): Promise<unknown> =>
    await withTransaction(db, async () => await work(competitor, call, db));

  /** What the competitor must have answered, given which of the two committed first. */
  function expectCompetitor(competitor: Competitor, answered: unknown, applyFirst: boolean): void {
    switch (competitor) {
      case 'status':
      case 'recording':
        expect(answered).toMatchObject({ known: true });
        return;
      case 'build':
        expect(answered).toMatchObject({ written: expect.any(Number) });
        return;
      case 'basics':
      case 'basicsOrdinary':
        expect(answered).toMatchObject({ ok: true });
        return;
      case 'logOutcome':
        expect(answered).toMatchObject(applyFirst ? { ok: false, reason: 'call_already_logged' } : { ok: true });
        return;
      case 'optOut':
        expect(answered).toEqual({ handle: true, firm: true });
    }
  }

  async function settled<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    try {
      return { ok: true, value: await promise };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const COMPETITORS: readonly Competitor[] = ['status', 'recording', 'build', 'basics', 'basicsOrdinary', 'logOutcome', 'optOut'];

  for (const competitor of COMPETITORS) {
    it(`${competitor}: the Apply first, the competitor waits, and both finish`, async () => {
      const { call, keys } = await prepare(competitor);
      await a.query('BEGIN');
      const { applyCallProposals } = await import('../../calls/proposalApply.ts');
      const held = await applyCallProposals(world.salesperson(a), {
        analysisId: call.analysisId,
        transcriptSha256: call.transcriptSha256,
        proposalHash: call.proposalHash,
        keys,
        commandId: `c4-apply-first-${competitor}`,
        journal: recordingSuppressionJournal(),
      });
      expect(held.ok, JSON.stringify(held)).toBe(true);
      const second = settled(run(competitor, call, b));
      expect(await waitsOn(world.session, await pidOf(a))).toBe(true);
      await a.query('COMMIT');
      const answered = await second;
      expect(answered.ok, String(answered.ok ? '' : answered.error)).toBe(true);
      if (answered.ok) expectCompetitor(competitor, answered.value, true);
    });

    it(`${competitor}: the competitor first, the Apply waits, and both finish`, async () => {
      const { call, keys } = await prepare(competitor);
      await b.query('BEGIN');
      const first = await work(competitor, call, b);
      const second = settled(apply(world, call, keys, { db: a, commandId: `c4-apply-second-${competitor}` }));
      expect(await waitsOn(world.session, await pidOf(b))).toBe(true);
      await b.query('COMMIT');
      const applied = await second;
      expect(applied.ok, String(applied.ok ? '' : applied.error)).toBe(true);
      expectCompetitor(competitor, first, false);
      if (applied.ok) {
        if (competitor === 'logOutcome') expect(applied.value).toEqual(refusedAt('call_already_logged', 'outcome'));
        else expect(applied.value.ok, JSON.stringify(applied.value)).toBe(true);
      }
    });

    it(`${competitor}: the Apply stopped half-way (holding Today, the gate, the route and the firm), the competitor blocks on it, and both finish`, async () => {
      const { call, keys } = await prepare(competitor);
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        callAnalysisLockKey(world.seeded.alpha.workspaceId, call.sessionId),
      ]);
      const applying = settled(apply(world, call, keys, { db: a, commandId: `c4-apply-paused-${competitor}` }));
      expect(await waitsOn(world.session, await pidOf(blocker))).toBe(true);
      const competing = settled(run(competitor, call, b));
      expect(await isBlocked(await pidOf(b))).toBe(true);
      await blocker.query('COMMIT');
      const [applied, answered] = await Promise.all([applying, competing]);
      expect(applied.ok, String(applied.ok ? '' : applied.error)).toBe(true);
      expect(answered.ok, String(answered.ok ? '' : answered.error)).toBe(true);
      if (applied.ok) expect(applied.value.ok, JSON.stringify(applied.value)).toBe(true);
      if (answered.ok) expectCompetitor(competitor, answered.value, true);
    });
  }

  // David's own wrong-number outcome against the same number being replaced on the firm's
  // basics (found while building C4; pre-existing since S2, fixed in 3a): `logCallOutcome`
  // now takes the route it retires before the firm, the order `updateFirmBasics` keeps.
  // And (review S3B, finding 1) an ordinary outcome: its call-log insert takes the route's
  // foreign-key lock, so `logCallOutcome` takes the route (`FOR KEY SHARE`) before the firm too.
  for (const outcome of ['wrong_number', 'interested'] as const) {
    describe(`David's logCallOutcome(${outcome}) against updateFirmBasics replacing the dialled number`, () => {
      const competitor: Competitor = outcome === 'wrong_number' ? 'basics' : 'basicsOrdinary';
      const logByForm = async (call: Analysed, db: SessionQueryable) =>
        await logCallOutcome(world.salesperson(db), {
          firmId: call.firm.firmId,
          callSessionId: call.sessionId,
          outcome,
          commandId: `form-${outcome}-${call.sessionId}`,
          journal: recordingSuppressionJournal(),
        });
    // David's own wrong-number outcome against the same number being replaced on the firm's
    // basics (found while building C4; pre-existing since S2, fixed in 3a): `logCallOutcome`
    // now takes the route it retires before the firm, the order `updateFirmBasics` keeps.

      for (const first of ['logCallOutcome', 'updateFirmBasics'] as const) {
        it(`${first} first: the other waits, and both finish`, async () => {
          const { call } = await prepare(competitor);
          await a.query('BEGIN');
          const held = first === 'logCallOutcome' ? await logByForm(call, a) : await work(competitor, call, a);
          expect(held).toMatchObject({ ok: true });
          const second = settled(first === 'logCallOutcome' ? run(competitor, call, b) : withTransaction(b, async () => await logByForm(call, b)));
          expect(await waitsOn(world.session, await pidOf(a))).toBe(true);
          await a.query('COMMIT');
          const answered = await second;
          expect(answered.ok, String(answered.ok ? '' : answered.error)).toBe(true);
          if (answered.ok) expect(answered.value).toMatchObject({ ok: true });
        });
      }

      it('logCallOutcome stopped after the firm (on the session row), the edit blocks on it, and both finish', async () => {
        const { call } = await prepare(competitor);
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM call_sessions WHERE id = $1 FOR UPDATE', [call.sessionId]);
        const logging = settled(withTransaction(a, async () => await logByForm(call, a)));
        expect(await waitsOn(world.session, await pidOf(blocker))).toBe(true);
        const editing = settled(run(competitor, call, b));
        expect(await isBlocked(await pidOf(b))).toBe(true);
        await blocker.query('COMMIT');
        const [logged, edited] = await Promise.all([logging, editing]);
        expect(logged.ok, String(logged.ok ? '' : logged.error)).toBe(true);
        expect(edited.ok, String(edited.ok ? '' : edited.error)).toBe(true);
        if (logged.ok) expect(logged.value).toMatchObject({ ok: true });
        if (edited.ok) expect(edited.value).toMatchObject({ ok: true });
      });
    });
  }
});
