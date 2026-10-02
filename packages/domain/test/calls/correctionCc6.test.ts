import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallOutcome, CorrectionPreviewResponse } from '@fss/contracts';
import { correctCallOutcome } from '../../calls/correctOutcome.ts';
import { recordCallStatus } from '../../calls/sessions.ts';
import { updateFirmBasics } from '../../crm/firmBasics.ts';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { scheduleCallbackForCall } from '../../dial/callbacks.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { buildTodaySnapshot } from '../../today/build.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import { applyCallProposals } from '../../calls/proposalApply.ts';
import { answer, lines } from './analysisFixtures.ts';
import { createApplyWorld, pidOf, waitsOn, type Analysed, type ApplyWorld, type PlacedCall, type TestFirm } from './support/applyWorld.ts';
import { callbackFields, logFormCall, logPlacedCall, preview, QUIET_CALL } from './support/correctionWorld.ts';

/**
 * S3X contract check CC6 (DESIGN-S3X §5): an outcome correction cannot deadlock and cannot be
 * overtaken by a stale read. Real PostgreSQL, `app_runtime` connections: each competitor in
 * both orders, and once more with the correction stopped half-way — holding Today, the gate,
 * the route and the firm, waiting for the call log's row that a third connection holds —
 * while the competitor starts and blocks on it. Every pair must finish.
 *
 * The three the brief names first:
 *
 *   * **`scheduleCallbackForCall` while the correction to `no_answer` holds the firm** (S3XD
 *     3): the schedule waits, re-reads the log under the firm lock, and refuses
 *     `call_log_unknown`; no callback row. (Fails with the post-lock re-read reverted.)
 *   * **Apply** (a callback on the existing log): Apply first → the correction meets the new
 *     callback, `effects_changed`; correction first → Apply runs on the corrected log.
 *   * **a second correction** from the same review: `stale_outcome`.
 *
 * And from §5's list: `logCallOutcome` at the same firm, the status callback, `updateFirmBasics`
 * replacing the dialled number (the correction to `wrong_number` takes the route first), and
 * the morning build.
 */

const CALLBACK_CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Call me back Thursday at 2.']);
const CALLBACK_READING = answer({
  summary: 'Dana asked to be called back Thursday at 2.',
  interest: { level: 'curious', signals: [] },
  callback: { requested: true, exact: true, phrase: 'Call me back Thursday at 2', line: 2, agreed_line: 0, day: 'thursday', date_text: 'Thursday', time: '2' },
});

type Competitor = 'schedule' | 'apply' | 'correction' | 'logOutcome' | 'status' | 'basics' | 'build';

interface Prepared {
  readonly firm: TestFirm;
  readonly logId: string;
  readonly target: CallOutcome;
  readonly shown: CorrectionPreviewResponse;
  readonly call?: PlacedCall | Analysed;
}

describe('CC6: the correction against its competitors, in both orders and stopped half-way', () => {
  let world: ApplyWorld;
  let a: SessionQueryable;
  let b: SessionQueryable;
  let blocker: SessionQueryable;

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
      const { rows } = await world.session.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid]);
      if (rows[0]?.blocked === true) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  }

  async function settled<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    try {
      return { ok: true, value: await promise };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function prepare(competitor: Competitor): Promise<Prepared> {
    const firm = await world.newFirm();
    switch (competitor) {
      case 'schedule': {
        const logId = await logFormCall(world, firm, 'callback_requested');
        return { firm, logId, target: 'no_answer', shown: await preview(world, logId, 'no_answer') };
      }
      case 'apply': {
        const call = await world.analyse(await world.placeCall(firm, CALLBACK_CALL), CALLBACK_READING);
        const logId = await logPlacedCall(world, call, 'interested');
        return { firm, logId, call, target: 'no_answer', shown: await preview(world, logId, 'no_answer') };
      }
      case 'status': {
        const call = await world.placeCall(firm, QUIET_CALL, { recordingSeconds: null, transcript: false, statuses: [{ status: 'in-progress' }] });
        const logId = await logPlacedCall(world, call, 'no_answer');
        return { firm, logId, call, target: 'interested', shown: await preview(world, logId, 'interested') };
      }
      case 'basics': {
        const logId = await logFormCall(world, firm, 'no_answer');
        return { firm, logId, target: 'wrong_number', shown: await preview(world, logId, 'wrong_number') };
      }
      default: {
        const logId = await logFormCall(world, firm, 'interested');
        return { firm, logId, target: 'no_answer', shown: await preview(world, logId, 'no_answer') };
      }
    }
  }

  /** The correction, as the route runs it, from the review `shown`. */
  const correction = async (p: Prepared, db: SessionQueryable, target = p.target) =>
    await withTransaction(db, async () => await correctionWork(p, db, target));
  const correctionWork = async (p: Prepared, db: SessionQueryable, target = p.target) =>
    await correctCallOutcome(world.salesperson(db), {
      callLogId: p.logId,
      expectedOutcome: p.shown.currentOutcome,
      outcome: target,
      effects: p.shown.effects
        .filter(effect => effect.conflicts)
        .map(effect => ({ kind: effect.kind, id: effect.id, state: effect.state, decision: effect.decisions.includes('keep') ? 'keep' : 'undo' })),
      commandId: `cc6-${randomUUID()}`,
      journal: recordingSuppressionJournal(),
    });

  /** The competitor's work on `db`, inside whatever transaction the caller opened. */
  async function work(competitor: Competitor, p: Prepared, db: SessionQueryable): Promise<unknown> {
    switch (competitor) {
      case 'schedule':
        return await scheduleCallbackForCall(world.salesperson(db), { callLogId: p.logId, ...callbackFields() });
      case 'apply': {
        const call = p.call as Analysed;
        return await applyCallProposals(world.salesperson(db), {
          analysisId: call.analysisId,
          transcriptSha256: call.transcriptSha256,
          proposalHash: call.proposalHash,
          keys: ['callback'],
          commandId: `cc6-apply-${randomUUID()}`,
          journal: recordingSuppressionJournal(),
        });
      }
      case 'correction':
        // A second correction from the same review, to another outcome.
        return await correctionWork(p, db, 'not_interested');
      case 'logOutcome':
        return await logCallOutcome(world.salesperson(db), {
          firmId: p.firm.firmId,
          contactId: p.firm.contactId,
          routeId: p.firm.routeId,
          outcome: 'voicemail_left',
          commandId: `cc6-log-${randomUUID()}`,
          journal: recordingSuppressionJournal(),
        });
      case 'status':
        return await recordCallStatus(db, { callSid: (p.call as PlacedCall).callSid, providerStatus: 'completed', durationSeconds: 40 });
      case 'basics':
        return await updateFirmBasics(world.salesperson(db), {
          firmId: p.firm.firmId,
          phone: { number: `+1401556${String(Math.floor(1000 + Math.random() * 8999))}`, replacesRouteId: p.firm.routeId },
        });
      case 'build': {
        const now = (await db.query<{ now: Date }>('SELECT now() AS now')).rows[0]?.now.toISOString() ?? '';
        return await buildTodaySnapshot(world.system(db), { businessDate: await businessDateOf(world.system(db), now), now });
      }
    }
  }

  const run = async (competitor: Competitor, p: Prepared, db: SessionQueryable): Promise<unknown> =>
    await withTransaction(db, async () => await work(competitor, p, db));

  const callbacksOf = async (logId: string): Promise<number> =>
    Number((await world.session.query<{ n: string }>('SELECT count(*)::text AS n FROM callbacks WHERE call_log_id = $1', [logId])).rows[0]?.n);

  /** What each side must have answered, given which committed first. */
  async function expectBoth(competitor: Competitor, p: Prepared, corrected: unknown, competed: unknown, correctionFirst: boolean): Promise<void> {
    switch (competitor) {
      case 'schedule':
        if (correctionFirst) {
          expect(corrected).toMatchObject({ ok: true });
          // The post-lock re-read: the corrected log no longer asks for a callback.
          expect(competed).toEqual({ ok: false, reason: 'call_log_unknown' });
          expect(await callbacksOf(p.logId)).toBe(0);
        } else {
          expect(competed).toMatchObject({ ok: true });
          expect(corrected).toEqual({ ok: false, reason: 'effects_changed' });
          expect(await callbacksOf(p.logId)).toBe(1);
        }
        return;
      case 'apply':
        if (correctionFirst) {
          expect(corrected).toMatchObject({ ok: true });
          expect(competed).toMatchObject({ ok: true });
        } else {
          expect(competed).toMatchObject({ ok: true });
          expect(corrected).toEqual({ ok: false, reason: 'effects_changed' });
        }
        return;
      case 'correction':
        // Whichever commits second meets the outcome the first wrote.
        if (correctionFirst) {
          expect(corrected).toMatchObject({ ok: true });
          expect(competed).toEqual({ ok: false, reason: 'stale_outcome' });
        } else {
          expect(competed).toMatchObject({ ok: true });
          expect(corrected).toEqual({ ok: false, reason: 'stale_outcome' });
        }
        return;
      case 'status':
        expect(corrected).toMatchObject({ ok: true });
        expect(competed).toMatchObject({ known: true });
        return;
      case 'build':
        expect(corrected).toMatchObject({ ok: true });
        expect(competed).toMatchObject({ written: expect.any(Number) });
        return;
      default:
        expect(corrected).toMatchObject({ ok: true });
        expect(competed).toMatchObject({ ok: true });
    }
  }

  const COMPETITORS: readonly Competitor[] = ['schedule', 'apply', 'correction', 'logOutcome', 'status', 'basics', 'build'];

  for (const competitor of COMPETITORS) {
    it(`${competitor}: the correction first, the competitor waits, and both finish`, async () => {
      const p = await prepare(competitor);
      await a.query('BEGIN');
      const held = await correctionWork(p, a);
      const second = settled(run(competitor, p, b));
      expect(await waitsOn(world.session, await pidOf(a))).toBe(true);
      await a.query('COMMIT');
      const answered = await second;
      expect(answered.ok, String(answered.ok ? '' : answered.error)).toBe(true);
      if (answered.ok) await expectBoth(competitor, p, held, answered.value, true);
    });

    it(`${competitor}: the competitor first, the correction waits, and both finish`, async () => {
      const p = await prepare(competitor);
      await b.query('BEGIN');
      const first = await work(competitor, p, b);
      const second = settled(correction(p, a));
      expect(await waitsOn(world.session, await pidOf(b))).toBe(true);
      await b.query('COMMIT');
      const corrected = await second;
      expect(corrected.ok, String(corrected.ok ? '' : corrected.error)).toBe(true);
      if (corrected.ok) await expectBoth(competitor, p, corrected.value, first, false);
    });

    it(`${competitor}: the correction stopped half-way (holding Today, the gate, the route and the firm), the competitor blocks on it, and both finish`, async () => {
      const p = await prepare(competitor);
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM call_logs WHERE id = $1 FOR UPDATE', [p.logId]);
      const correcting = settled(correction(p, a));
      expect(await waitsOn(world.session, await pidOf(blocker))).toBe(true);
      const competing = settled(run(competitor, p, b));
      expect(await isBlocked(await pidOf(b))).toBe(true);
      await blocker.query('COMMIT');
      const [corrected, competed] = await Promise.all([correcting, competing]);
      expect(corrected.ok, String(corrected.ok ? '' : corrected.error)).toBe(true);
      expect(competed.ok, String(competed.ok ? '' : competed.error)).toBe(true);
      if (corrected.ok && competed.ok) await expectBoth(competitor, p, corrected.value, competed.value, true);
    });
  }
});
