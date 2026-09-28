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
 * what these tests record through.
 *
 * **The vacuous-pass trap for the overlap.** `posture_overlapping` is still reachable
 * from the route, and by only one shape: a state whose posture is recorded to *begin in
 * the future*. `allowCallingStates` asks `applicablePosture` about *now*, finds none in
 * force, and inserts a row effective now with no end, which overlaps the future one and
 * is refused by `state_postures_no_overlap` — SQLSTATE 23P01, inside the command's
 * transaction. Without the route's savepoint that error has already aborted the
 * transaction, so the receipt insert after it fails and the API answers 500 where the
 * domain answered `posture_overlapping`. A state already in force is a different case
 * and answers `alreadyAllowed`; the test below drives the overlap itself, and asserts
 * both halves the savepoint buys: the state added before the refusal is taken back, and
 * the receipt is written.
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

  it('refuses an overlapping allow as posture_overlapping, with a receipt and nothing added, not a 500', async () => {
    // A posture recorded to begin next year, which `POST /postures/record` used to be
    // able to write and no route can now. It is a row the database holds either way,
    // and it is the only state from which an allow overlaps.
    await fixture.db.query(
      `INSERT INTO state_postures
         (workspace_id, state, revision, effective_from, review_at, rules_revision,
          confirmed_statements, sources, confirmed_by_user_id)
       VALUES ($1, 'VT', 1, now() + interval '365 days', now() + interval '731 days', 1,
               ARRAY['business_to_business'], '[]'::jsonb, $2)`,
      [fixture.alpha.workspaceId, fixture.alpha.admin.userId],
    );

    // WY first, so the refusal happens after a row has already been inserted: what the
    // savepoint takes back is asserted rather than assumed.
    const commandId = randomUUID();
    const refused = await call('POST', '/postures/allow', adminToken, {
      commandId,
      clientVersion: CURRENT_CLIENT_VERSION,
      states: ['WY', 'VT'],
      confirmed: true,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body).toMatchObject({ status: 'refused', reason: 'posture_overlapping' });

    // Nothing was added: the savepoint rolled WY back, and VT still has only the one
    // future row this test wrote.
    const rows = await fixture.db.query<{ state: string; count: string }>(
      `SELECT state, count(*)::text AS count FROM state_postures
        WHERE workspace_id = $1 AND state IN ('WY', 'VT') GROUP BY state ORDER BY state`,
      [fixture.alpha.workspaceId],
    );
    expect(rows.rows).toEqual([{ state: 'VT', count: '1' }]);

    // And the receipt committed, which is the half the savepoint exists for: without it
    // the aborted transaction could not write this row and the answer was a 500.
    const receipt = await fixture.db.query<{ command_kind: string; result_status: string; result: unknown }>(
      'SELECT command_kind, result_status, result FROM command_receipts WHERE workspace_id = $1 AND command_id = $2',
      [fixture.alpha.workspaceId, commandId],
    );
    expect(receipt.rows).toHaveLength(1);
    expect(receipt.rows[0]).toMatchObject({ command_kind: 'allow_calling_states', result_status: 'refused' });
    expect(JSON.stringify(receipt.rows[0]?.result)).toContain('posture_overlapping');

    // The list is unchanged by a refused command, and WY is still not on it.
    const listed = statePostureListResponseSchema.parse((await call('GET', '/postures', adminToken)).body);
    expect(listed.postures.map(posture => posture.state)).not.toContain('WY');
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
