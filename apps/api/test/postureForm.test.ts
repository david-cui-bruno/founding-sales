import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowCallingStatesResultSchema,
  postureReferenceResponseSchema,
  statePostureListResponseSchema,
  statePostureViewSchema,
  wireDrift,
} from '@fss/contracts';
import {
  POSTURE_RULES_REVISION,
  POSTURE_STATEMENTS,
  STATE_POSTURE_RULES,
  US_STATE_CODES,
} from '@fss/domain/src/rules/statePosture.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
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
 * `POST /postures/record` — one state with its statements ticked one by one — went with
 * the 1.0.14 minimum (lane W3-C2). `/postures/allow` is what the form sends, and it is
 * what these tests record through. The overlap case that used to live here went with
 * `record`: `allowCallingStates` answers `alreadyAllowed` for a state already in force
 * rather than reaching the exclusion constraint, so there is no route that can produce
 * `posture_overlapping` any more. The savepoint the route still takes is what keeps a
 * concurrent allow that does reach 23P01 answerable rather than a 500
 * (`packages/domain/test/policy` proves the domain half).
 */
describe('the postures form’s reads and commands', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let salespersonToken = '';

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
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

  const allow = async (token: string, body: Record<string, unknown>) =>
    await call('POST', '/postures/allow', token, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...body,
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
    const recorded = await allow(adminToken, { states: ['RI'], confirmed: true });
    expect(recorded.status).toBe(200);
    const view = allowCallingStatesResultSchema.parse(recorded.body['result']).postures[0];
    expect(wireDrift(statePostureViewSchema, view)).toEqual([]);

    const listed = await call('GET', '/postures', adminToken);
    expect(wireDrift(statePostureListResponseSchema, listed.body)).toEqual([]);
    const postures = statePostureListResponseSchema.parse(listed.body).postures;
    expect(postures.map(posture => [posture.state, posture.revision, posture.revokedAt])).toEqual([['RI', 1, null]]);
    // The review date still defaults to a year out (10.1), and nothing acts on it: a
    // posture has no yearly expiry since wave 2 (S4.2).
    expect(postures[0]?.reviewAt).not.toBeNull();
  });

  it('answers alreadyAllowed for a state already in force rather than overlapping it', async () => {
    const again = await allow(adminToken, { states: ['RI'], confirmed: true });
    expect(again.status).toBe(200);
    expect(allowCallingStatesResultSchema.parse(again.body['result']).alreadyAllowed).toEqual(['RI']);
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
    const again = await allow(adminToken, { states: ['RI'], confirmed: true });
    expect(again.status).toBe(200);
    const view = allowCallingStatesResultSchema.parse(again.body['result']).postures[0];
    expect(view?.revision).toBe(2);
  });

  it('puts several states on the "OK to call" list with one confirmation, exactly as the contract says (wave 2)', async () => {
    const answer = await allow(adminToken, { states: ['CT', 'nh'], confirmed: true });
    expect(answer.status).toBe(200);
    expect(wireDrift(allowCallingStatesResultSchema, answer.body['result'])).toEqual([]);
    const result = allowCallingStatesResultSchema.parse(answer.body['result']);
    expect([result.added, result.alreadyAllowed]).toEqual([['CT', 'NH'], []]);
    expect(result.postures.map(posture => [posture.state, posture.effectiveTo])).toEqual([
      ['CT', null],
      ['NH', null],
    ]);

    const again = allowCallingStatesResultSchema.parse((await allow(adminToken, { states: ['NH'], confirmed: true })).body['result']);
    expect(again.alreadyAllowed).toEqual(['NH']);

    // The confirmation is required, and so is being an admin.
    expect((await allow(adminToken, { states: ['ME'] })).status).toBe(400);
    const refused = await allow(salespersonToken, { states: ['ME'], confirmed: true });
    expect([refused.status, refused.body['reason']]).toEqual([409, 'admin_only']);
  });

});
