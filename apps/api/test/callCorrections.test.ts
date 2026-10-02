import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callLogsResponseSchema,
  correctCallOutcomeResultSchema,
  correctionPreviewResponseSchema,
  wireDrift,
  type CorrectionPreviewResponse,
} from '@fss/contracts';
import { recordingSuppressionJournal, type RecordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';

/**
 * S3X lane X2 — correcting a logged outcome, through the real dispatcher with real sessions.
 *
 *   * `GET /calls?firmId=` lists every log of the firm from the database alone — a form log,
 *     an incoming log — while the calling provider is not Twilio (`/calls/history` answers 404
 *     in the same workspace), with `direction`, `durationSeconds` and `callSessionId`, and
 *     `include=corrections` adds the history (X2-10, RESET C);
 *   * `POST /calls/logs/correction-preview` and `POST /calls/logs/correct`: the wire shapes,
 *     the receipt (the same command id is answered from it), the 409 codes, the 404;
 *   * CC8 through the routes: a correction with "Lift stop…" journals nothing; the follow-up
 *     `POST /suppressions/supersede` — unchanged — journals exactly one supersession;
 *   * a lost journal write on a correction to `do_not_call` is the 503 with the id left free.
 */
describe('outcome correction routes', () => {
  let fixture: AuthFixture;
  let journal: RecordingSuppressionJournal;
  let assigneeToken: string;
  let adminToken: string;
  let firmId: string;
  let contactId: string;
  let routeId: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: journal,
  });

  const call = async (method: 'GET' | 'POST', path: string, token: string, body?: unknown, query = '') => {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(query),
      headers: { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: result.body as Record<string, unknown> };
  };
  const post = async (path: string, token: string, body: unknown) => await call('POST', path, token, body);
  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });
  const resultOf = (answer: { body: Record<string, unknown> }): Record<string, unknown> => (answer.body['result'] ?? {}) as Record<string, unknown>;

  async function log(token: string, extra: Record<string, unknown>): Promise<string> {
    const logged = await post('/calls/log', token, command({ firmId, ...extra }));
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    return String(resultOf(logged)['callLogId']);
  }

  async function previewOf(token: string, callLogId: string, outcome: string): Promise<CorrectionPreviewResponse> {
    const shown = await post('/calls/logs/correction-preview', token, { callLogId, outcome });
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(wireDrift(correctionPreviewResponseSchema, shown.body)).toEqual([]);
    return correctionPreviewResponseSchema.parse(shown.body);
  }

  const echo = (shown: CorrectionPreviewResponse, decide: (decisions: readonly string[]) => string) =>
    shown.effects.filter(effect => effect.conflicts).map(effect => ({ kind: effect.kind, id: effect.id, state: effect.state, decision: decide(effect.decisions) }));

  beforeAll(async () => {
    fixture = await createAuthFixture();
    journal = recordingSuppressionJournal();
    assigneeToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    firmId = await seedFirm(fixture, { name: 'Correction Test Holdings', regionCode: 'RI', postalCode: '02903', assignedUserId: fixture.alpha.salesperson.userId });
    contactId = await seedContact(fixture, { firmId, fullName: 'Dana Example' });
    const route = await post(
      '/contacts/routes/add',
      assigneeToken,
      command({ firmId, contactId, routeKind: 'phone', value: '+14015550287', source: 'salesperson', technicalValidation: 'passed', associationConfidence: 0.95 }),
    );
    expect(route.status, JSON.stringify(route.body)).toBe(200);
    routeId = String(resultOf(route)['id']);
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('X2-10: GET /calls lists form and incoming logs with the provider not Twilio, and include=corrections adds the history', async () => {
    const form = await log(assigneeToken, { contactId, routeId, outcome: 'no_answer' });
    const inbound = await log(assigneeToken, { contactId, outcome: 'interested', direction: 'inbound', durationSeconds: 95 });
    // The session read refuses before reading anything: Twilio is not the provider here.
    expect((await call('GET', '/calls/history', assigneeToken, undefined, `firmId=${firmId}`)).status).toBe(404);

    const plain = await call('GET', '/calls', assigneeToken, undefined, `firmId=${firmId}`);
    expect(plain.status).toBe(200);
    expect(wireDrift(callLogsResponseSchema, plain.body)).toEqual([]);
    const rows = callLogsResponseSchema.parse(plain.body).calls;
    expect(rows.find(row => row.id === form)).toMatchObject({ direction: 'outbound', durationSeconds: null, callSessionId: null });
    expect(rows.find(row => row.id === inbound)).toMatchObject({ direction: 'inbound', durationSeconds: 95, callSessionId: null });
    expect(rows.every(row => row.corrections === undefined)).toBe(true);

    // Each corrected by its call log id; an incoming call refuses an unanswered outcome.
    const shown = await previewOf(assigneeToken, form, 'interested');
    const corrected = await post('/calls/logs/correct', assigneeToken, command({ callLogId: form, expectedOutcome: 'no_answer', outcome: 'interested', effects: echo(shown, () => 'keep') }));
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    const refusedInbound = await post('/calls/logs/correction-preview', assigneeToken, { callLogId: inbound, outcome: 'no_answer' });
    expect(refusedInbound).toEqual({ status: 409, body: { status: 'refused', reason: 'outcome_not_correctable' } });
    const inboundShown = await previewOf(assigneeToken, inbound, 'not_interested');
    expect((await post('/calls/logs/correct', assigneeToken, command({ callLogId: inbound, expectedOutcome: 'interested', outcome: 'not_interested', effects: echo(inboundShown, () => 'keep') }))).status).toBe(200);

    const withHistory = await call('GET', '/calls', assigneeToken, undefined, `firmId=${firmId}&include=corrections`);
    expect(wireDrift(callLogsResponseSchema, withHistory.body)).toEqual([]);
    const history = callLogsResponseSchema.parse(withHistory.body).calls;
    expect(history.find(row => row.id === form)?.corrections).toEqual([
      expect.objectContaining({ from: 'no_answer', to: 'interested', byUserId: fixture.alpha.salesperson.userId, reason: null }),
    ]);
    expect(history.find(row => row.id === inbound)?.corrections?.map(entry => [entry.from, entry.to])).toEqual([['interested', 'not_interested']]);
  });

  it('the command: a receipt answers the same id, a stale review is 409 stale_outcome, an unknown log is 404 on the preview', async () => {
    const logId = await log(assigneeToken, { contactId, routeId, outcome: 'busy' });
    const shown = await previewOf(assigneeToken, logId, 'voicemail_left');
    const body = command({ callLogId: logId, expectedOutcome: 'busy', outcome: 'voicemail_left', effects: echo(shown, () => 'keep') });
    const first = await post('/calls/logs/correct', assigneeToken, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(wireDrift(correctCallOutcomeResultSchema, resultOf(first))).toEqual([]);
    expect(correctCallOutcomeResultSchema.parse(resultOf(first))).toMatchObject({ outcome: 'voicemail_left', revision: 1, liftNext: [] });
    const again = await post('/calls/logs/correct', assigneeToken, body);
    expect(again.body).toMatchObject({ status: 'accepted', replayed: true, result: resultOf(first) });
    const stale = await post('/calls/logs/correct', assigneeToken, command({ callLogId: logId, expectedOutcome: 'busy', outcome: 'no_answer', effects: [] }));
    expect(stale).toEqual({ status: 409, body: { status: 'refused', replayed: false, reason: 'stale_outcome' } });
    expect((await post('/calls/logs/correction-preview', assigneeToken, { callLogId: randomUUID(), outcome: 'interested' })).status).toBe(404);
    // A decision is required on every echoed effect: no default, so a body without one does not parse.
    const malformed = await post('/calls/logs/correct', assigneeToken, command({ callLogId: logId, expectedOutcome: 'voicemail_left', outcome: 'busy', effects: [{ kind: 'callback', id: randomUUID(), state: 'open' }] }));
    expect(malformed.status).toBe(400);
  });

  it('CC8 through the routes: "Lift stop…" journals nothing; the unchanged supersede route journals exactly one', async () => {
    // David is the admin and the person who made the call.
    const logId = await log(adminToken, { contactId, routeId, outcome: 'do_not_call' });
    const journalled = journal.appended.length;
    const shown = await previewOf(adminToken, logId, 'interested');
    const stops = shown.effects.filter(effect => effect.kind === 'stop');
    expect(stops.map(stop => stop.decisions)).toEqual([['keep', 'lift']]);
    const corrected = await post(
      '/calls/logs/correct',
      adminToken,
      command({ callLogId: logId, expectedOutcome: 'do_not_call', outcome: 'interested', effects: echo(shown, decisions => (decisions.includes('lift') ? 'lift' : 'keep')) }),
    );
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    const result = correctCallOutcomeResultSchema.parse(resultOf(corrected));
    expect(result.liftNext.map(lift => lift.eventId)).toEqual(stops.map(stop => stop.id));
    expect(journal.appended.length).toBe(journalled);
    const lifted = await post('/suppressions/supersede', adminToken, command({ eventId: result.liftNext[0]?.eventId, reason: 'correction' }));
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    expect(journal.appended.slice(journalled).map(record => [record.source, record.supersedesEventId])).toEqual([['admin_supersession', result.liftNext[0]?.eventId]]);
  });

  it('a lost journal write on a correction to do_not_call is 503 and leaves the command id free', async () => {
    const logId = await log(assigneeToken, { contactId, routeId, outcome: 'not_interested' });
    const shown = await previewOf(assigneeToken, logId, 'do_not_call');
    const body = command({ callLogId: logId, expectedOutcome: 'not_interested', outcome: 'do_not_call', effects: echo(shown, () => 'keep') });
    journal.failNext();
    expect((await post('/calls/logs/correct', assigneeToken, body)).status).toBe(503);
    const retried = await post('/calls/logs/correct', assigneeToken, body);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(resultOf(retried)['outcome']).toBe('do_not_call');
  });
});
