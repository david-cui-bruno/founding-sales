import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_POLICY_VERSION, proposalAcceptanceResponseSchema } from '@fss/contracts';
import { declineCallProposals, readProposalAcceptance } from '../../calls/proposalMeasure.ts';
import { withTransaction } from '../../db/queryable.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { answer, lines } from './analysisFixtures.ts';
import { apply, createApplyWorld, type Analysed, type ApplyWorld } from './support/applyWorld.ts';

/**
 * Slice 3a, lane B — the shadow measurement (B-11, B-15, and B-2's decline).
 *
 *   * B-11: one `call.proposal_decided` audit row per decided key — `unchanged` and `edited`
 *     from an Apply, `declined` from a decline, `bypassed` when the form logged a call that
 *     had an authoritative analysis — and the acceptance read counts the latest per key.
 *   * B-15: per action type, `insufficient` below five decided suggestions; every declined
 *     or edited stop or deal-opening suggestion listed by id.
 *   * B-2: a decline records the measurement only; the proposal applies later.
 */

const SIGNAL_CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', "We're evaluating tools. Can you show us a demo?"]);
const SIGNAL = answer({
  summary: 'You reached Dana. She asked for a demo.',
  interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
});
const STOP_CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Please stop calling me.']);
const STOP = answer({
  summary: 'Dana asked not to be called.',
  stop: { requested: true, scope: 'this_number', quote: 'Please stop calling me', line: 2 },
});

describe('the shadow measurement', () => {
  let world: ApplyWorld;

  beforeAll(async () => {
    world = await createApplyWorld();
  });
  afterAll(async () => {
    await world.drop();
  });

  const call = async (utterances = SIGNAL_CALL, reading = SIGNAL): Promise<Analysed> =>
    await world.analyse(await world.placeCall(await world.newFirm(), utterances), reading);
  const decisionsOf = async (analysisId: string) =>
    (
      await world.session.query<{ key: string; result: string; type: string; version: number; policy: string; hash: string }>(
        `SELECT detail->>'key' AS key, detail->>'result' AS result, detail->>'type' AS type, (detail->>'version')::int AS version,
                detail->>'policyVersion' AS policy, detail->>'proposalHash' AS hash
           FROM audit_events WHERE action = 'call.proposal_decided' AND subject_id = $1 ORDER BY occurred_at, detail->>'key'`,
        [analysisId],
      )
    ).rows;
  const decline = async (shown: Analysed, keys: readonly string[]) =>
    await withTransaction(world.session, async () =>
      await declineCallProposals(world.salesperson(), { analysisId: shown.analysisId, proposalHash: shown.proposalHash, keys }),
    );
  const acceptance = async () => proposalAcceptanceResponseSchema.parse(await readProposalAcceptance(world.salesperson()));

  it('B-2: a decline records the measurement only, and the proposal applies later', async () => {
    const shown = await call();
    expect(await decline(shown, ['buying_signal'])).toEqual({ ok: true, value: { analysisId: shown.analysisId, declined: ['buying_signal'] } });
    expect((await world.session.query('SELECT 1 FROM opportunities WHERE firm_id = $1', [shown.firm.firmId])).rows).toHaveLength(0);
    expect((await apply(world, shown, ['outcome', 'buying_signal'])).ok).toBe(true);
    expect((await decisionsOf(shown.analysisId)).map(row => [row.key, row.result])).toEqual([
      ['buying_signal', 'declined'],
      ['buying_signal', 'unchanged'],
      ['outcome', 'unchanged'],
    ]);
    // A decline is checked as an Apply is: the stored hash, the authoritative version.
    expect(await decline(shown, ['outcome'].concat())).toMatchObject({ ok: true });
    expect(
      await withTransaction(world.session, async () =>
        await declineCallProposals(world.salesperson(), { analysisId: shown.analysisId, proposalHash: 'a'.repeat(64), keys: ['outcome'] }),
      ),
    ).toEqual({ ok: false, reason: 'stale_proposal' });
    expect(await decline(shown, ['park'])).toEqual({ ok: false, reason: 'proposal_unknown' });
  });

  it('B-11: one row per decided key — unchanged, edited, declined and bypassed — naming the version, hash and policy', async () => {
    const applied = await call(STOP_CALL, STOP);
    const result = await apply(world, applied, ['outcome'], { edits: { outcome: { doNotCallCoversAllContact: true } } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const [edited] = await decisionsOf(applied.analysisId);
    expect(edited).toEqual({ key: 'outcome', result: 'edited', type: 'stop', version: applied.version, policy: CALL_POLICY_VERSION, hash: applied.proposalHash });

    // The form, on a call with an authoritative analysis: bypassed.
    const bypassed = await call();
    const logged = await withTransaction(world.session, async () =>
      await logCallOutcome(world.salesperson(), {
        firmId: bypassed.firm.firmId,
        callSessionId: bypassed.sessionId,
        outcome: 'interested',
        commandId: `form-${bypassed.sessionId}`,
        journal: recordingSuppressionJournal(),
      }),
    );
    expect(logged.ok).toBe(true);
    expect((await decisionsOf(bypassed.analysisId)).map(row => [row.key, row.result, row.type])).toEqual([['outcome', 'bypassed', 'outcome:interested']]);
  });

  it('B-15: insufficient below five decided suggestions of a type; incorrect stop and deal-opening suggestions listed by id', async () => {
    const before = await acceptance();
    const signalBefore = before.types.find(type => type.type === 'buying_signal');
    const decidedBefore = (signalBefore?.unchanged ?? 0) + (signalBefore?.edited ?? 0) + (signalBefore?.declined ?? 0) + (signalBefore?.bypassed ?? 0);

    // Decide buying signals until five are decided: insufficient at four, not at five.
    const declinedSignal = await call();
    expect((await decline(declinedSignal, ['buying_signal'])).ok).toBe(true);
    let decided = decidedBefore + 1;
    while (decided < 4) {
      expect((await apply(world, await call(), ['buying_signal'])).ok).toBe(true);
      decided += 1;
    }
    expect((await acceptance()).types.find(type => type.type === 'buying_signal')).toMatchObject({ insufficient: true });
    const undecided = await call();
    expect((await acceptance()).types.find(type => type.type === 'buying_signal')?.undecided).toBeGreaterThanOrEqual(1);
    expect((await apply(world, undecided, ['buying_signal'])).ok).toBe(true);
    const signal = (await acceptance()).types.find(type => type.type === 'buying_signal');
    expect(signal).toMatchObject({ insufficient: false });
    const total = (signal?.unchanged ?? 0) + (signal?.edited ?? 0) + (signal?.declined ?? 0) + (signal?.bypassed ?? 0);
    expect(total).toBe(5);
    expect(signal?.acceptedUnchangedShare).toBeCloseTo((signal?.unchanged ?? 0) / 5);

    // A declined stop suggestion is incorrect too.
    const stop = await call(STOP_CALL, STOP);
    expect((await decline(stop, ['outcome'])).ok).toBe(true);
    const read = await acceptance();
    expect(read.incorrect).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ analysisId: declinedSignal.analysisId, key: 'buying_signal', type: 'buying_signal', result: 'declined' }),
        expect.objectContaining({ analysisId: stop.analysisId, key: 'outcome', type: 'stop', result: 'declined' }),
      ]),
    );
    expect(read.types.find(type => type.type === 'stop')).toMatchObject({ insufficient: true });
    expect(read.incorrect.every(entry => entry.result === 'declined' || entry.result === 'edited')).toBe(true);
  });
});
