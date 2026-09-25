import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  postureReferenceResponseSchema,
  statePostureListResponseSchema,
  statePostureViewSchema,
  wireDrift,
} from '@fss/contracts';
import { POSTURE_RULES_REVISION, POSTURE_STATEMENTS, POSTURE_STATEMENT_KEYS, STATE_POSTURE_RULES, US_STATE_CODES } from '@fss/domain';
import { recordingSuppressionJournal } from '@fss/domain/suppression';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * What the postures form reads and writes (lane g84, audit item G04).
 *
 * Until g84 Settings printed `/postures` and a lane name where the form should be, and
 * nothing on the Mac read these answers. Now Administration does, so each is held to the
 * schema the desktop parses it with (`wireDrift` is empty), and the reference texts are
 * compared with `statePosture.ts` itself: the form shows the release's words, not a copy.
 *
 * **The vacuous-pass trap for the overlap.** A second posture for a state already in force
 * was refused by the database's exclusion constraint inside the command's transaction, and
 * the refusal left that transaction unable to write its receipt: the API answered 500 where
 * the domain answered `posture_overlapping`. The domain's own test never saw it, because it
 * does not run inside `runCommand`. This one records the overlap through the route.
 */
describe('the postures form’s reads and commands', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let salespersonToken = '';

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: recordingSuppressionJournal(),
  });

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const result = await dispatch(
      { method, path, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` }, body },
      options(),
    );
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body)) as Record<string, unknown> };
  };

  const record = async (token: string, state: string, effectiveFrom: string) =>
    await call('POST', '/postures/record', token, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      state,
      effectiveFrom,
      confirmedStatements: [...POSTURE_STATEMENT_KEYS],
      note: 'Checked the registration page.',
    });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('serves the reference texts verbatim, to any member, exactly as the contract says', async () => {
    const answer = await call('GET', '/postures/reference', salespersonToken);
    expect(answer.status).toBe(200);
    expect(wireDrift(postureReferenceResponseSchema, answer.body)).toEqual([]);
    const reference = postureReferenceResponseSchema.parse(answer.body);
    expect(reference.rulesRevision).toBe(POSTURE_RULES_REVISION);
    expect(reference.statements).toEqual(Object.entries(POSTURE_STATEMENTS).map(([key, text]) => ({ key, text })));
    expect(reference.states.map(entry => entry.state)).toEqual([...US_STATE_CODES]);
    const rhodeIsland = reference.states.find(entry => entry.state === 'RI');
    expect(rhodeIsland?.rule?.summary).toBe(STATE_POSTURE_RULES.RI.summary);
    expect(rhodeIsland?.rule?.citations[0]?.quote).toBe(STATE_POSTURE_RULES.RI.citation.quote);
    expect(reference.states.find(entry => entry.state === 'AL')?.rule).toBeNull();
  });

  it('records a posture and lists it, exactly as the contract says', async () => {
    const recorded = await record(adminToken, 'RI', '2026-09-01T04:00:00.000Z');
    expect(recorded.status).toBe(200);
    expect(wireDrift(statePostureViewSchema, recorded.body['result'])).toEqual([]);

    const listed = await call('GET', '/postures', adminToken);
    expect(wireDrift(statePostureListResponseSchema, listed.body)).toEqual([]);
    const postures = statePostureListResponseSchema.parse(listed.body).postures;
    expect(postures.map(posture => [posture.state, posture.revision, posture.revokedAt])).toEqual([['RI', 1, null]]);
    // The review date defaults to a year after the posture takes effect (10.1).
    expect(postures[0]?.reviewAt).toBe('2027-09-01T04:00:00.000Z');
  });

  it('refuses an overlapping posture as posture_overlapping, with a receipt, not a 500', async () => {
    const overlapping = await record(adminToken, 'RI', '2026-10-01T04:00:00.000Z');
    expect(overlapping.status).toBe(409);
    expect(overlapping.body).toMatchObject({ status: 'refused', reason: 'posture_overlapping' });
    const listed = statePostureListResponseSchema.parse((await call('GET', '/postures', adminToken)).body);
    expect(listed.postures.filter(posture => posture.state === 'RI')).toHaveLength(1);
  });

  it('revokes a posture and answers with the same row shape, so a new one may then be recorded', async () => {
    const listed = statePostureListResponseSchema.parse((await call('GET', '/postures', adminToken)).body);
    const current = listed.postures.find(posture => posture.state === 'RI' && posture.revokedAt === null);
    const revoked = await call('POST', '/postures/revoke', adminToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      postureId: current?.id,
    });
    expect(revoked.status).toBe(200);
    expect(wireDrift(statePostureViewSchema, revoked.body['result'])).toEqual([]);
    const again = await record(adminToken, 'RI', '2026-10-01T04:00:00.000Z');
    expect(again.status).toBe(200);
    expect(statePostureViewSchema.parse(again.body['result']).revision).toBe(2);
  });

  it('keeps recording to admins', async () => {
    const refused = await record(salespersonToken, 'MA', '2026-09-01T04:00:00.000Z');
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('admin_only');
  });
});
