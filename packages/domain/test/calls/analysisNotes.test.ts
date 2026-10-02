import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callAnalysisResponseSchema } from '@fss/contracts';
import {
  CALL_ANALYSIS_MAX_MODEL_VERSIONS,
  completeCallAnalysis,
  createAnalysisVersion,
  editCallAnalysis,
  failCallAnalysis,
  readCallAnalysis,
  readPolicyContext,
} from '../../calls/analysis.ts';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { updateSetting } from '../../settings/store.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';
import { answer, lines } from './analysisFixtures.ts';
import { transcribedCall } from './support/transcribedCall.ts';

/**
 * Slice 3a, A-3 (check C5): David's notes outrank every later model version, through the
 * production writers only — `createAnalysisVersion`, `completeCallAnalysis` and
 * `editCallAnalysis` — on a real database, with the competing writers on two connections.
 *
 *   * Edit, then reanalyse, then complete: the user notes stay current; the new model version
 *     is stored, listed and authoritative for its proposals, and never the notes.
 *   * A completion racing an edit, in both orders: each waits for the other on the firm row
 *     and `call_analysis:<session>` (observed with `pg_blocking_pids`), and either way the
 *     notes are David's.
 */

const UTTERANCES = lines(
  ['Y', 'Hi Dana, this is David from Callie.'],
  ['T', "We're evaluating a couple of tools. Can you show us a demo?"],
  ['Y', 'Absolutely. I will send you a calendar link today.'],
);
const GOOD = answer({
  summary: 'You reached Dana. She is evaluating tools and asked for a demo. You promised a calendar link.',
  facts: [{ text: 'They are evaluating a couple of tools', line: 2 }],
  interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
  commitments: [{ speaker: 'you', quote: 'I will send you a calendar link today', line: 3, due_phrase: 'today' }],
});
const REREAD = answer({
  summary: 'A second reading. Dana asked for a demo.',
  interest: { level: 'buying_signal', signals: [{ kind: 'evaluation', quote: "We're evaluating a couple of tools", line: 2 }] },
});
const NOTES = { summary: 'Dana wants a demo next week; she runs 240 doors.', facts: ['240 doors', 'Uses a clunky portal'] };

describe('A-3 (C5): the current notes through the production writers', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let other: SessionQueryable;
  let third: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;

  const system = (db: SessionQueryable = session): RepositoryContext =>
    repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), db);
  const salesperson = (db: SessionQueryable = session): RepositoryContext =>
    repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      db,
    );

  async function modelVersion(sessionId: string, reason: 'transcript' | 'reanalysis' = 'transcript', db = session): Promise<string> {
    const created = await withTransaction(db, async () =>
      await createAnalysisVersion(system(db), { sessionId, origin: 'model', reason, model: 'claude-haiku-4-5-20251001' }),
    );
    if (created.kind !== 'created') throw new Error(`model version: ${created.kind}`);
    return created.analysisId;
  }
  async function complete(analysisId: string, sessionId: string, raw: string, db = session) {
    return await withTransaction(db, async () => {
      const policyContext = await readPolicyContext(system(db), sessionId);
      if (policyContext === null) throw new Error('no policy context');
      return await completeCallAnalysis(system(db), { analysisId, rawAnswer: raw, utterances: UTTERANCES, policyContext, answeredBy: 'claude-haiku-4-5-20251001' });
    });
  }
  async function edit(sessionId: string, notes = NOTES, db = session) {
    const edited = await withTransaction(db, async () => await editCallAnalysis(salesperson(db), { sessionId, notes }));
    if (!edited.ok) throw new Error(edited.reason);
    return edited.value;
  }
  const read = async (sessionId: string) => {
    const value = await readCallAnalysis(salesperson(), sessionId);
    if (value === null) throw new Error('no analysis read');
    return callAnalysisResponseSchema.parse(value);
  };

  async function waitsOn(blockerPid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const { rows } = await session.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND $1::int = ANY(pg_blocking_pids(pid))`,
        [blockerPid],
      );
      if (Number(rows[0]?.count ?? 0) > 0) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  }
  const pidOf = async (db: SessionQueryable): Promise<number> =>
    Number((await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    crm = await seedCrm(session, seeded);
    policy = await seedPolicy(session, seeded, crm);
    const admin = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), session);
    const saved = await withTransaction(session, async () =>
      await updateSetting(admin, { settingKey: 'telephony_budget', value: { dailyCeilingCents: 10_000, maxMinutesPerCall: 30, unitPriceMicros: 14_000 } }),
    );
    if (!saved.ok) throw new Error(saved.reason);
    other = await database.appRuntimeSession();
    third = await database.appRuntimeSession();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('edit, then reanalyse, then complete: the user notes stay current, and the new model version is authoritative for its proposals only', async () => {
    const sessionId = await transcribedCall(session, { seeded, crm, policy }, UTTERANCES);
    const v1 = await modelVersion(sessionId);
    expect(await complete(v1, sessionId, GOOD)).toMatchObject({ kind: 'completed', version: 1 });
    const first = await read(sessionId);
    expect(first.current).toMatchObject({ analysisId: v1, origin: 'model', notes: { summary: expect.stringContaining('You reached Dana') } });
    expect(first.authoritative?.analysisId).toBe(v1);
    expect(first.authoritative?.proposals.map(proposal => proposal.key)).toContain('buying_signal');

    const edited = await edit(sessionId);
    expect(edited.current).toMatchObject({ version: 2, origin: 'user', notes: NOTES });

    const v3 = await modelVersion(sessionId, 'reanalysis');
    const pendingRead = await read(sessionId);
    expect(pendingRead.pending).toMatchObject({ analysisId: v3, version: 3 });
    expect(pendingRead.current).toMatchObject({ version: 2, origin: 'user' });

    expect(await complete(v3, sessionId, REREAD)).toMatchObject({ kind: 'completed', version: 3 });
    const after = await read(sessionId);
    expect(after.current).toEqual({ analysisId: edited.current?.analysisId, version: 2, origin: 'user', notes: NOTES });
    expect(after.notesVersion).toBe(2);
    expect(after.authoritative).toMatchObject({ analysisId: v3, version: 3 });
    expect(after.pending).toBeNull();
    expect(after.versions.map(version => [version.version, version.origin, version.state])).toEqual([
      [3, 'model', 'completed'],
      [2, 'user', 'completed'],
      [1, 'model', 'completed'],
    ]);
  });

  for (const first of ['completion', 'edit'] as const) {
    it(`a completion racing an edit (${first} first): the second waits on the first, and the notes are David's either way`, async () => {
      const sessionId = await transcribedCall(session, { seeded, crm, policy }, UTTERANCES);
      const v1 = await modelVersion(sessionId);

      // The first writer runs on `other` and holds its transaction open; the second, on
      // `third`, must wait for it; `session` watches.
      await other.query('BEGIN');
      let firstOutcome: unknown;
      if (first === 'completion') {
        const policyContext = await readPolicyContext(system(other), sessionId);
        if (policyContext === null) throw new Error('no policy context');
        firstOutcome = await completeCallAnalysis(system(other), { analysisId: v1, rawAnswer: GOOD, utterances: UTTERANCES, policyContext });
      } else {
        firstOutcome = await editCallAnalysis(salesperson(other), { sessionId, notes: NOTES });
      }
      const blocker = await pidOf(other);
      const second = first === 'completion' ? edit(sessionId, NOTES, third) : complete(v1, sessionId, GOOD, third);
      expect(await waitsOn(blocker)).toBe(true);
      await other.query('COMMIT');
      const secondOutcome = await second;

      if (first === 'completion') {
        expect(firstOutcome).toMatchObject({ kind: 'completed', version: 1 });
        expect(secondOutcome).toMatchObject({ current: { version: 2, origin: 'user' } });
      } else {
        expect(firstOutcome).toMatchObject({ ok: true, value: { current: { version: 2, origin: 'user' } } });
        expect(secondOutcome).toMatchObject({ kind: 'completed', version: 1 });
      }
      const after = await read(sessionId);
      expect(after.current).toMatchObject({ version: 2, origin: 'user', notes: NOTES });
      expect(after.authoritative).toMatchObject({ analysisId: v1, version: 1 });
    });
  }

  it('two edits at once are numbered one after the other, never the same version', async () => {
    const sessionId = await transcribedCall(session, { seeded, crm, policy }, UTTERANCES);
    await other.query('BEGIN');
    const held = await editCallAnalysis(salesperson(other), { sessionId, notes: NOTES });
    expect(held).toMatchObject({ ok: true });
    const blocker = await pidOf(other);
    const second = edit(sessionId, { summary: 'Second edit.', facts: [] }, third);
    expect(await waitsOn(blocker)).toBe(true);
    await other.query('COMMIT');
    expect((await second).current).toMatchObject({ version: 2, origin: 'user', notes: { summary: 'Second edit.' } });
  });

  it('a completion is refused once the version is no longer pending, and a changed transcript or an unreadable answer fails it', async () => {
    const sessionId = await transcribedCall(session, { seeded, crm, policy }, UTTERANCES);
    const v1 = await modelVersion(sessionId);
    // One pending model version per call at a time.
    expect(
      await withTransaction(session, async () =>
        await createAnalysisVersion(system(), { sessionId, origin: 'model', reason: 'retry', model: 'claude-haiku-4-5-20251001' }),
      ),
    ).toEqual({ kind: 'in_flight', analysisId: v1, version: 1 });
    expect(await complete(v1, sessionId, 'not json')).toEqual({ kind: 'failed', analysisId: v1, reason: 'malformed' });
    expect(await complete(v1, sessionId, GOOD)).toEqual({ kind: 'not_pending', state: 'failed' });
    expect((await read(sessionId)).failure).toEqual({ analysisId: v1, version: 1, reason: 'malformed' });
    expect((await read(sessionId)).current).toBeNull();

    const v2 = await modelVersion(sessionId, 'reanalysis');
    const changed = await withTransaction(session, async () => {
      const policyContext = await readPolicyContext(system(), sessionId);
      if (policyContext === null) throw new Error('no policy context');
      return await completeCallAnalysis(system(), { analysisId: v2, rawAnswer: GOOD, utterances: lines(['Y', 'Something else']), policyContext });
    });
    expect(changed).toEqual({ kind: 'failed', analysisId: v2, reason: 'transcript_changed' });

    const v3 = await modelVersion(sessionId, 'reanalysis');
    expect(await withTransaction(session, async () => await failCallAnalysis(system(), { analysisId: v3, reason: 'provider_error' }))).toMatchObject({
      kind: 'failed',
    });
    // Three model versions: the cap.
    expect(CALL_ANALYSIS_MAX_MODEL_VERSIONS).toBe(3);
    expect(
      await withTransaction(session, async () =>
        await createAnalysisVersion(system(), { sessionId, origin: 'model', reason: 'reanalysis', model: 'claude-haiku-4-5-20251001' }),
      ),
    ).toEqual({ kind: 'capped' });
  });

  it('a completion whose stored transcript was replaced while the model ran fails transcript_changed, even with the original utterances (S3A1 [7])', async () => {
    const sessionId = await transcribedCall(session, { seeded, crm, policy }, UTTERANCES);
    const v1 = await modelVersion(sessionId);
    await session.query('UPDATE call_transcripts SET utterances = $2::jsonb WHERE call_session_id = $1', [
      sessionId,
      JSON.stringify([...UTTERANCES, { speaker: 1, start: 30, end: 33, text: 'Thanks, bye.' }]),
    ]);
    expect(await complete(v1, sessionId, GOOD)).toEqual({ kind: 'failed', analysisId: v1, reason: 'transcript_changed' });
    expect((await read(sessionId)).failure).toEqual({ analysisId: v1, version: 1, reason: 'transcript_changed' });
    expect((await read(sessionId)).current).toBeNull();
  });

  it('the authoritative version is the newest completed one on the current transcript: a new transcript has none until it is analysed', async () => {
    const sessionId = await transcribedCall(session, { seeded, crm, policy }, UTTERANCES);
    const v1 = await modelVersion(sessionId);
    await complete(v1, sessionId, GOOD);
    expect((await read(sessionId)).authoritative?.analysisId).toBe(v1);
    await session.query('UPDATE call_transcripts SET utterances = $2::jsonb WHERE call_session_id = $1', [
      sessionId,
      JSON.stringify([...UTTERANCES, { speaker: 1, start: 30, end: 33, text: 'Thanks, bye.' }]),
    ]);
    const after = await read(sessionId);
    expect(after.authoritative).toBeNull();
    expect(after.current?.analysisId).toBe(v1);
  });

  it('another salesperson’s firm reads as unknown and cannot be edited', async () => {
    const sessionId = await transcribedCall(session, { seeded, crm, policy }, UTTERANCES);
    const stranger = repositoryContext(workspaceScope(seeded.beta.workspaceId, { kind: 'user', userId: seeded.beta.salesperson.userId, role: 'salesperson' }), session);
    expect(await readCallAnalysis(stranger, sessionId)).toBeNull();
    expect(await withTransaction(session, async () => await editCallAnalysis(stranger, { sessionId, notes: NOTES }))).toEqual({ ok: false, reason: 'not_found' });
  });
});
