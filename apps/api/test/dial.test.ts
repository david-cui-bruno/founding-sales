import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dialCheckResponseSchema, loggedCallResultSchema, wireDrift } from '@fss/contracts';
import { POSTURE_STATEMENT_KEYS } from '@fss/domain';
import { recordingSuppressionJournal, type RecordingSuppressionJournal } from '@fss/domain/suppression';
import { dispatch, type ApiRequest } from '../src/server.ts';
import {
  createS3SuppressionJournal,
  journalBody,
  localNoopSuppressionJournal,
  requireDurableJournal,
  resolveSuppressionJournal,
  JournalConfigurationError,
  type JournalPutRequest,
} from '../src/journal/index.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';

/**
 * The policy, suppression and dialing endpoints, through the real dispatcher with
 * real sessions.
 *
 * The rules have their own tests against a real PostgreSQL in `@fss/domain`; what is
 * proved here is the wiring, and three pieces of it are this lane's alone:
 *
 *   * a dial authorization replay answers `already_consumed` rather than an accepted
 *     command with an empty body, which is what the receipt on its own would give
 *     (5.3, 9.2);
 *   * the journal is written before the command acknowledges, and a journal failure
 *     fails the command with the id left free (10.2);
 *   * the note on a call log is dropped for a member who is not the assignee
 *     (Appendix F).
 */
describe('policy, suppression and dialing routes', () => {
  let fixture: AuthFixture;
  let journal: RecordingSuppressionJournal;
  let assigneeToken: string;
  let strangerToken: string;
  let adminToken: string;
  let assigneeUserId: string;
  let firmId: string;
  let contactId: string;
  let routeId: string;
  let routeVersion: number;
  let callingIdentityId: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: journal,
  });

  const post = async (
    path: string,
    token: string | null,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const get = async (
    path: string,
    token: string,
    query = '',
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const result = await dispatch(
      {
        method: 'GET',
        path,
        query: new URLSearchParams(query),
        headers: { authorization: `Bearer ${token}` },
        body: undefined,
      },
      options(),
    );
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  const resultOf = (answer: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answer.body['result'] ?? {}) as Record<string, unknown>;

  beforeAll(async () => {
    fixture = await createAuthFixture();
    journal = recordingSuppressionJournal();
    const assignee = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson);
    const admin = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin);
    assigneeToken = assignee.accessToken;
    adminToken = admin.accessToken;
    assigneeUserId = fixture.alpha.salesperson.userId;

    const strangerSub = `sub-${randomUUID()}`;
    const strangerEmail = `stranger-dial@${fixture.hostedDomain}`;
    const stranger = await fixture.db.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, 'Stranger') RETURNING id",
      [strangerSub, strangerEmail],
    );
    await fixture.db.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [fixture.alpha.workspaceId, stranger.rows[0]?.id],
    );
    strangerToken = (
      await issueSessionFor(fixture, fixture.alpha, { googleSub: strangerSub, email: strangerEmail }, { deviceLabel: 'Other Mac' })
    ).accessToken;

    firmId = await seedFirm(fixture, {
      name: 'Northwind Test Holdings',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: assigneeUserId,
    });
    // Providence, Rhode Island: the state default resolves the zone, which step 5
    // of `authorizeDial` requires before it will look at a posture at all.
    const zone = await post('/firms/resolve-zone', adminToken, command({ firmId }));
    expect(zone.status).toBe(200);

    contactId = await seedContact(fixture, { firmId, fullName: 'Dana Example' });

    const route = await post(
      '/contacts/routes/add',
      assigneeToken,
      command({
        firmId,
        contactId,
        routeKind: 'phone',
        value: '+14015550187',
        source: 'salesperson',
        technicalValidation: 'passed',
        associationConfidence: 0.95,
      }),
    );
    expect(route.status).toBe(200);
    routeId = String(resultOf(route)['id']);
    routeVersion = Number(resultOf(route)['version'] ?? 1);

    // The assignee's own number, through the product path a person takes (lane g60):
    // register it, then attest that it is the number they call from.
    const registered = await post('/calling-identities/register', assigneeToken, command({ e164: '+14015550100' }));
    expect(registered.status).toBe(200);
    callingIdentityId = String((resultOf(registered)['identity'] as Record<string, unknown>)['id']);
    const attested = await post(
      '/calling-identities/attest',
      assigneeToken,
      command({ identityId: callingIdentityId, attested: true }),
    );
    expect(attested.status).toBe(200);

    const posture = await post(
      '/postures/record',
      adminToken,
      command({
        state: 'RI',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        reviewAt: '2099-01-01T00:00:00.000Z',
        confirmedStatements: [...POSTURE_STATEMENT_KEYS],
      }),
    );
    expect(posture.status).toBe(200);
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses every path in this lane without a session', async () => {
    for (const path of [
      '/dial/authorize',
      '/dial/check',
      '/dial/consume',
      '/suppressions/record',
      '/postures/record',
      '/pauses/open',
      '/calls/log',
      '/callbacks/complete',
    ]) {
      expect((await post(path, null, command())).status).toBe(401);
    }
  });

  it('advises on a call without a ticket, and the call is then logged without one (wave 2, S4.5)', async () => {
    const checked = await post('/dial/check', assigneeToken, { firmId, routeId });
    expect(checked.status).toBe(200);
    expect(wireDrift(dialCheckResponseSchema, checked.body)).toEqual([]);
    const { advice } = dialCheckResponseSchema.parse(checked.body);
    // A URI only when the answer is yes (the window depends on the clock the suite runs at).
    expect(advice).toMatchObject({ firmId, routeId, telUri: advice.callable ? `tel:${advice.e164 ?? ''}` : null });
    // The calling window depends on the clock the suite runs at, and is tested in
    // `@fss/domain` where the instant is a parameter; nothing else stands in the way here.
    expect(advice.reasons.filter(reason => reason !== 'outside_calling_window')).toEqual([]);
    expect(advice.callable).toBe(advice.reasons.length === 0);

    // Nothing was written: a read, with no receipt.
    const receipts = await fixture.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE command_kind LIKE '%dial%'",
    );
    const before = receipts.rows[0]?.count;
    await post('/dial/check', assigneeToken, { firmId });
    const after = await fixture.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE command_kind LIKE '%dial%'",
    );
    expect(after.rows[0]?.count).toBe(before);

    // The Mac opens tel: itself and logs what happened, naming no ticket and no identity.
    const logged = await post('/calls/log', assigneeToken, command({ firmId, contactId, routeId, outcome: 'no_answer' }));
    expect(logged.status).toBe(200);

    expect((await post('/dial/check', strangerToken, { firmId })).status).toBe(404);
    expect((await post('/dial/check', assigneeToken, { firmId: 'not-a-uuid' })).status).toBe(400);
  });

  it('answers a dial authorization replay with already_consumed, never a second allow', async () => {
    const commandId = randomUUID();
    const body = {
      commandId,
      clientVersion: CURRENT_CLIENT_VERSION,
      firmId,
      contactId,
      routeId,
      routeVersion,
      callingIdentityId,
    };
    const first = await post('/dial/authorize', assigneeToken, body);
    // Whatever the clock says about the calling window, the replay rule holds; the
    // window itself is tested in `@fss/domain` where the instant is a parameter.
    if (first.status === 200) {
      const ticket = resultOf(first);
      expect(String(ticket['e164'])).toBe('+14015550187');

      const consumed = await post('/dial/consume', assigneeToken, command({ ticketId: ticket['ticketId'] }));
      expect(consumed.status).toBe(200);
      expect(resultOf(consumed)['telUri']).toBe('tel:+14015550187');

      const again = await post('/dial/consume', assigneeToken, command({ ticketId: ticket['ticketId'] }));
      expect(again.status).toBe(409);
      expect(again.body['reason']).toBe('already_consumed');
    } else {
      expect(first.status).toBe(409);
      expect(first.body['reason']).toBe('outside_calling_window');
    }

    // The receipt stores no result for `authorize_dial` (migration 0001), and the
    // route turns that empty replay into the refusal 9.2 names.
    const replay = await post('/dial/authorize', assigneeToken, body);
    expect(replay.status).toBe(409);
    expect(replay.body['reason']).toBe('already_consumed');
    expect(replay.body['result']).toBeUndefined();
  });

  it('refuses a calling identity that is not the actor own', async () => {
    const other = await fixture.db.query<{ id: string }>(
      `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled,
                                       verified_at, verified_by_user_id, verification_method)
       VALUES ($1, $2, '+14015550101', 'verified', true, now(), $2, 'owner_attestation') RETURNING id`,
      [fixture.alpha.workspaceId, fixture.alpha.admin.userId],
    );
    const answer = await post(
      '/dial/authorize',
      assigneeToken,
      command({ firmId, contactId, routeId, routeVersion, callingIdentityId: other.rows[0]?.id }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body['reason']).toBe('identity_not_owned');
  });

  it('refuses the reserved shared line, which has no owner', async () => {
    const shared = await fixture.db.query<{ id: string }>(
      `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled,
                                       verified_at, verified_by_user_id, verification_method)
       VALUES ($1, NULL, '+14015550102', 'verified', false, now(), $2, 'admin_attestation') RETURNING id`,
      [fixture.alpha.workspaceId, fixture.alpha.admin.userId],
    );
    const answer = await post(
      '/dial/authorize',
      assigneeToken,
      command({ firmId, contactId, routeId, routeVersion, callingIdentityId: shared.rows[0]?.id }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body['reason']).toBe('identity_shared_line_disabled');
  });

  /**
   * A firm of its own with one usable number, so a do-not-call (which also switches the
   * firm to manual) leaves the shared firm alone. The journal tests used
   * `/suppressions/record` until wave 2 (S6) deleted it: the Mac suppresses a number
   * by logging the call, and that path writes the same journal first.
   */
  const numberToSuppress = async (e164: string) => {
    const ownFirmId = await seedFirm(fixture, {
      name: `Suppression Test ${e164}`,
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: assigneeUserId,
    });
    const ownContactId = await seedContact(fixture, { firmId: ownFirmId, fullName: 'Pat Example' });
    const route = await post(
      '/contacts/routes/add',
      assigneeToken,
      command({ firmId: ownFirmId, contactId: ownContactId, routeKind: 'phone', value: e164, source: 'salesperson' }),
    );
    expect(route.status).toBe(200);
    return { firmId: ownFirmId, contactId: ownContactId, routeId: String(resultOf(route)['id']) };
  };

  it('writes the journal before it acknowledges a do-not-call suppression', async () => {
    const target = await numberToSuppress('+14015550190');
    const before = journal.appended.length;
    const logged = await post('/calls/log', assigneeToken, command({ ...target, outcome: 'do_not_call' }));
    expect(logged.status).toBe(200);
    const eventIds = resultOf(logged)['suppressionEventIds'] as string[];
    expect(eventIds.length).toBeGreaterThan(0);
    expect(journal.appended.length).toBe(before + eventIds.length);

    const handle = journal.appended.slice(before).find(entry => entry.canonicalKey === '+14015550190');
    expect(eventIds).toContain(handle?.eventId);
    expect(handle?.canonicalizerVersion).toBe('e164-lower.1');
  });

  it('fails the command and leaves the id free when the journal write fails', async () => {
    const target = await numberToSuppress('+14015550191');
    const commandId = randomUUID();
    const body = { commandId, clientVersion: CURRENT_CLIENT_VERSION, ...target, outcome: 'do_not_call' as const };
    journal.failNext();
    const failed = await post('/calls/log', assigneeToken, body);
    expect(failed.status).toBe(503);
    expect(failed.body['error']).toBe('journal_unavailable');

    const receipts = await fixture.db.query<{ count: string }>(
      'SELECT count(*) AS count FROM command_receipts WHERE workspace_id = $1 AND command_id = $2',
      [fixture.alpha.workspaceId, commandId],
    );
    expect(Number(receipts.rows[0]?.count)).toBe(0);

    // The same id, once the bucket is back.
    const retried = await post('/calls/log', assigneeToken, body);
    expect(retried.status).toBe(200);
    expect(retried.body['replayed']).toBe(false);
  });

  // The manual record command, restored by the wave 2 batch review: the one durable way
  // to record a stop request that did not arrive by Gmail, a reply or a call.
  it('writes the journal before it acknowledges a manually recorded suppression', async () => {
    const before = journal.appended.length;
    const recorded = await post(
      '/suppressions/record',
      assigneeToken,
      command({ scope: 'handle', value: '+1 401 555 0192', firmId, source: 'salesperson_manual' }),
    );
    expect(recorded.status).toBe(200);
    expect(journal.appended.length).toBe(before + 1);

    const appended = journal.appended.at(-1);
    expect(appended?.eventId).toBe(resultOf(recorded)['eventId']);
    // Canonicalized server-side: the caller typed spaces and got E.164.
    expect(appended?.canonicalKey).toBe('+14015550192');
    expect(appended?.canonicalizerVersion).toBe('e164-lower.1');

    const listed = await get('/suppressions', assigneeToken);
    expect(listed.status).toBe(200);
    const suppressions = listed.body['suppressions'] as { canonicalKey: string }[];
    expect(suppressions.some(row => row.canonicalKey === '+14015550192')).toBe(true);
  });

  it('fails a manual record and leaves the id free when the journal write fails', async () => {
    const commandId = randomUUID();
    const body = {
      commandId,
      clientVersion: CURRENT_CLIENT_VERSION,
      scope: 'handle' as const,
      value: '+14015550193',
      firmId,
      source: 'salesperson_manual' as const,
    };
    journal.failNext();
    const failed = await post('/suppressions/record', assigneeToken, body);
    expect(failed.status).toBe(503);
    expect(failed.body['error']).toBe('journal_unavailable');

    const receipts = await fixture.db.query<{ count: string }>(
      'SELECT count(*) AS count FROM command_receipts WHERE workspace_id = $1 AND command_id = $2',
      [fixture.alpha.workspaceId, commandId],
    );
    expect(Number(receipts.rows[0]?.count)).toBe(0);

    // The same id, once the bucket is back.
    const retried = await post('/suppressions/record', assigneeToken, body);
    expect(retried.status).toBe(200);
    expect(retried.body['replayed']).toBe(false);
  });

  it('never hands a suppressed number a URI through /dial/check', async () => {
    const target = await numberToSuppress('+14015550199');
    const recorded = await post(
      '/suppressions/record',
      assigneeToken,
      command({ scope: 'handle', value: '+14015550199', firmId: target.firmId, source: 'prospect_do_not_call' }),
    );
    expect(recorded.status).toBe(200);
    const checked = await post('/dial/check', assigneeToken, { firmId: target.firmId, routeId: target.routeId });
    expect(checked.status).toBe(200);
    const { advice } = dialCheckResponseSchema.parse(checked.body);
    expect(advice.callable).toBe(false);
    expect(advice.reasons).toContain('handle_suppressed');
    expect(advice.telUri).toBeNull();
  });

  it('corrects a mistaken entry by its author and lets an admin supersede one', async () => {
    const mistaken = await post(
      '/suppressions/record',
      assigneeToken,
      command({ scope: 'handle', value: '+14015550196', firmId, source: 'salesperson_manual' }),
    );
    expect(mistaken.status).toBe(200);
    const corrected = await post('/suppressions/correct', assigneeToken, command({ eventId: resultOf(mistaken)['eventId'] }));
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);

    const reconsented = await post(
      '/suppressions/record',
      assigneeToken,
      command({ scope: 'handle', value: '+14015550197', firmId, source: 'salesperson_manual' }),
    );
    expect(reconsented.status).toBe(200);
    const eventId = resultOf(reconsented)['eventId'];
    // Supersession is an admin's alone (10.2).
    expect((await post('/suppressions/supersede', assigneeToken, command({ eventId, reason: 'documented_reconsent' }))).status).toBe(409);
    const superseded = await post('/suppressions/supersede', adminToken, command({ eventId, reason: 'documented_reconsent' }));
    expect(superseded.status, JSON.stringify(superseded.body)).toBe(200);
  });

  it('records a call outcome and hides the note from a member who is not the assignee', async () => {
    const logged = await post(
      '/calls/log',
      assigneeToken,
      command({
        firmId,
        contactId,
        routeId,
        outcome: 'voicemail_left',
        occurredAt: new Date().toISOString(),
        note: 'left a message about the demo',
      }),
    );
    expect(logged.status).toBe(200);
    expect(resultOf(logged)['stepEffect']).toBe('complete_and_advance');

    const mine = await get('/calls', assigneeToken, `firmId=${firmId}`);
    expect((mine.body['calls'] as { note: string | null }[])[0]?.note).toBe('left a message about the demo');

    const theirs = await get('/calls', strangerToken, `firmId=${firmId}`);
    expect(theirs.status).toBe(200);
    expect((theirs.body['calls'] as { note: string | null }[])[0]?.note).toBeNull();
  });

  it('records a callback request without an instant, and puts the time on Today to set later (lane g79, C13)', async () => {
    const withoutInstant = await post(
      '/calls/log',
      assigneeToken,
      command({ firmId, outcome: 'callback_requested' }),
    );
    // "Call logging ... never refuses history" (9.1): the call is recorded, and what it
    // still needs is said rather than refused.
    expect(withoutInstant.status).toBe(200);
    const logged = resultOf(withoutInstant);
    // Every key the route sends is one the contract declares (lane g78's wireDrift).
    expect(wireDrift(loggedCallResultSchema, logged)).toEqual([]);
    expect(logged['callbackId']).toBeNull();
    expect(logged['followUps']).toEqual([{ kind: 'callback_time_needed', reason: 'no_instant' }]);
    const callLogId = String(logged['callLogId']);

    // The instant the salesperson now confirms is resolved by the server, and a dueAt
    // that disagrees with it is refused (C18).
    const wrong = await post(
      '/callbacks/schedule',
      assigneeToken,
      command({
        callLogId,
        localDate: '2026-09-22',
        localTime: '14:00',
        sourceTimeZone: 'America/New_York',
        dueAt: '2026-09-22T19:00:00.000Z',
      }),
    );
    expect(wrong.status).toBe(409);
    expect(wrong.body['reason']).toBe('callback_instant_mismatch');

    const scheduled = await post(
      '/callbacks/schedule',
      assigneeToken,
      command({ callLogId, localDate: '2026-09-22', localTime: '14:00', sourceTimeZone: 'America/New_York' }),
    );
    expect(scheduled.status).toBe(200);
    expect(resultOf(scheduled)['dueAt']).toBe('2026-09-22T18:00:00.000Z');
    const twice = await post(
      '/callbacks/schedule',
      assigneeToken,
      command({ callLogId, localDate: '2026-09-23', sourceTimeZone: 'America/New_York' }),
    );
    expect(twice.status).toBe(409);
    expect(twice.body['reason']).toBe('callback_already_scheduled');
  });

  it('creates a callback with a confirmed instant, refuses a disagreeing one, and completes it once', async () => {
    const mismatched = await post(
      '/calls/log',
      assigneeToken,
      command({
        firmId,
        contactId,
        outcome: 'callback_requested',
        callback: {
          localDate: '2026-09-22',
          localTime: '14:00',
          // An hour off: what a client resolving on its own clock would have sent.
          dueAt: '2026-09-22T17:00:00.000Z',
          sourceTimeZone: 'America/New_York',
        },
      }),
    );
    expect(mismatched.status).toBe(200);
    expect(resultOf(mismatched)['callbackId']).toBeNull();
    expect(resultOf(mismatched)['followUps']).toEqual([{ kind: 'callback_time_needed', reason: 'instant_mismatch' }]);

    const withInstant = await post(
      '/calls/log',
      assigneeToken,
      command({
        firmId,
        contactId,
        outcome: 'callback_requested',
        callback: {
          localDate: '2026-09-22',
          localTime: '14:00',
          dueAt: '2026-09-22T18:00:00.000Z',
          sourceTimeZone: 'America/New_York',
        },
      }),
    );
    expect(withInstant.status).toBe(200);
    const callbackId = resultOf(withInstant)['callbackId'];
    expect(callbackId).not.toBeNull();
    expect(resultOf(withInstant)['followUps']).toEqual([]);

    const listed = await get('/callbacks', assigneeToken, 'open=true');
    expect((listed.body['callbacks'] as { id: string }[]).some(row => row.id === callbackId)).toBe(true);

    // A colleague cannot complete the assignee's callback (Appendix G 7).
    const theirs = await post('/callbacks/complete', strangerToken, command({ callbackId }));
    expect(theirs.status).toBe(409);
    expect(theirs.body['reason']).toBe('not_assigned');

    expect((await post('/callbacks/complete', assigneeToken, command({ callbackId }))).status).toBe(200);
    const second = await post('/callbacks/complete', assigneeToken, command({ callbackId }));
    expect(second.status).toBe(409);
    expect(second.body['reason']).toBe('callback_not_open');
  });

  it('records "just now" on the server clock, and refuses a time that has not happened (lane g79, C15)', async () => {
    const clock = await fixture.db.query<{ now: Date }>('SELECT now() AS now');
    const before = (clock.rows[0]?.now ?? new Date()).getTime();
    const justNow = await post('/calls/log', assigneeToken, command({ firmId, outcome: 'no_answer' }));
    expect(justNow.status).toBe(200);
    expect(Date.parse(String(resultOf(justNow)['occurredAt']))).toBeGreaterThanOrEqual(before);

    // A Mac thirty seconds fast is an unsynchronised clock, read as now...
    const fast = await post(
      '/calls/log',
      assigneeToken,
      command({ firmId, outcome: 'busy', occurredAt: new Date(Date.now() + 30_000).toISOString() }),
    );
    expect(fast.status).toBe(200);
    expect(Date.parse(String(resultOf(fast)['occurredAt']))).toBeLessThanOrEqual(Date.now() + 1_000);

    // ...an hour ahead is a time that has not happened...
    const future = await post(
      '/calls/log',
      assigneeToken,
      command({ firmId, outcome: 'busy', occurredAt: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    expect(future.status).toBe(409);
    expect(future.body['reason']).toBe('occurred_at_in_future');

    // ...and yesterday is history, kept as entered.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const entered = await post('/calls/log', assigneeToken, command({ firmId, outcome: 'busy', occurredAt: yesterday }));
    expect(entered.status).toBe(200);
    expect(resultOf(entered)['occurredAt']).toBe(yesterday);
  });

  it('refuses a route from another firm before anything is written (lane g79, S15)', async () => {
    const otherFirmId = await seedFirm(fixture, {
      name: 'Larkspur Test Foundry',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: assigneeUserId,
    });
    const before = await fixture.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM call_logs WHERE workspace_id = $1',
      [fixture.alpha.workspaceId],
    );
    const answer = await post(
      '/calls/log',
      assigneeToken,
      command({ firmId: otherFirmId, routeId, outcome: 'wrong_number' }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body['reason']).toBe('route_unknown');
    const after = await fixture.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM call_logs WHERE workspace_id = $1',
      [fixture.alpha.workspaceId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const route = await fixture.db.query<{ eligibility: string }>(
      'SELECT eligibility FROM phone_routes WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, routeId],
    );
    expect(route.rows[0]?.eligibility).not.toBe('retired');
  });

  it('keeps posture and pause administration to admins', async () => {
    expect(
      (
        await post(
          '/postures/record',
          assigneeToken,
          command({
            state: 'MA',
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            confirmedStatements: [...POSTURE_STATEMENT_KEYS],
          }),
        )
      ).body['reason'],
    ).toBe('admin_only');
    expect((await post('/pauses/open', assigneeToken, command({ scopeKind: 'workspace' }))).body['reason']).toBe(
      'admin_only',
    );

    const opened = await post('/pauses/open', adminToken, command({ scopeKind: 'channel', channel: 'call' }));
    expect(opened.status).toBe(200);
    const pauseId = resultOf(opened)['id'];

    // The pause is a hold blocking `dial_authorization`. That it *refuses the dial*
    // is asserted in `@fss/domain`, where the instant is a parameter; here the wall
    // clock decides whether step 7 refuses first, so the deterministic assertion is
    // the hold itself.
    const holds = await fixture.db.query<{ reason_code: string }>(
      `SELECT reason_code FROM active_holds
        WHERE workspace_id = $1 AND released_at IS NULL AND 'dial_authorization' = ANY (blocked_action_kinds)`,
      [fixture.alpha.workspaceId],
    );
    expect(holds.rows.map(row => row.reason_code)).toContain('scoped_pause');

    expect((await post('/pauses/release', adminToken, command({ pauseId }))).status).toBe(200);
    const listed = await get('/pauses', assigneeToken);
    expect((listed.body['pauses'] as { id: string; releasedAt: string | null }[]).some(row => row.id === pauseId)).toBe(
      true,
    );
  });

  it('reads the posture list and the calling window', async () => {
    const postures = await get('/postures', assigneeToken, 'state=RI');
    expect((postures.body['postures'] as { state: string }[]).every(row => row.state === 'RI')).toBe(true);

    const floor = await get('/postures/calling-window', assigneeToken);
    expect(floor.body['callingWindow']).toMatchObject({ version: 0 });

    expect((await post('/postures/calling-window', adminToken, command({ startMinute: 540, endMinute: 1020 }))).status).toBe(200);
    const narrowed = await get('/postures/calling-window', assigneeToken);
    expect(narrowed.body['callingWindow']).toMatchObject({ version: 1, window: { startMinute: 540, endMinute: 1020 } });

    expect(
      (await post('/postures/calling-window', adminToken, command({ startMinute: 420, endMinute: 1020 }))).body['reason'],
    ).toBe('window_not_narrower');
  });
});

describe('the suppression journal client', () => {
  it('writes a conditional, redacted object and names no secret', async () => {
    const requests: JournalPutRequest[] = [];
    const journal = createS3SuppressionJournal({
      bucket: 'fss-suppression-journal-test',
      putObject: async request => {
        requests.push(request);
        return await Promise.resolve('written');
      },
    });
    await journal.append({
      eventId: 'sup_abc',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      scope: 'handle',
      canonicalKey: '+14015550123',
      canonicalizerVersion: 'e164-lower.1',
      source: 'prospect_opt_out',
      actorUserId: null,
      commandId: 'cmd-1',
      supersedesEventId: null,
      supersessionReason: null,
      recordedAt: '2026-09-16T14:00:00.000Z',
    });
    const request = requests[0];
    expect(request?.key).toBe('suppressions/11111111-1111-4111-8111-111111111111/sup_abc.json');
    // Object Lock would refuse an overwrite anyway; saying so here makes a replay
    // safe rather than dependent on the bucket's retention settings.
    expect(request?.ifNoneMatch).toBe('*');
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({ schema: 'fss.suppression.v1', eventId: 'sup_abc' });
  });

  it('turns a transport failure into a SuppressionJournalError with no detail in it', async () => {
    const journal = createS3SuppressionJournal({
      bucket: 'fss-suppression-journal-test',
      putObject: async () => {
        return await Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:443'));
      },
    });
    await expect(journal.append({
      eventId: 'sup_def',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      scope: 'firm',
      canonicalKey: '22222222-2222-4222-8222-222222222222',
      canonicalizerVersion: 'e164-lower.1',
      source: 'salesperson_manual',
      actorUserId: null,
      commandId: null,
      supersedesEventId: null,
      supersessionReason: null,
      recordedAt: '2026-09-16T14:00:00.000Z',
    })).rejects.toMatchObject({ name: 'SuppressionJournalError', code: 'JOURNAL_UNAVAILABLE' });
  });

  it('falls back to the local no-op without a bucket, and production refuses that', async () => {
    const resolved = resolveSuppressionJournal({ bucket: null, putObject: null });
    expect(resolved).toMatchObject({ durable: false, description: 'local_noop' });
    await expect(localNoopSuppressionJournal().append({
      eventId: 'sup_ghi',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      scope: 'firm',
      canonicalKey: '22222222-2222-4222-8222-222222222222',
      canonicalizerVersion: 'e164-lower.1',
      source: 'import',
      actorUserId: null,
      commandId: null,
      supersedesEventId: null,
      supersessionReason: null,
      recordedAt: '2026-09-16T14:00:00.000Z',
    })).resolves.toBeUndefined();
    expect(() => requireDurableJournal(resolved)).toThrow(JournalConfigurationError);

    const durable = resolveSuppressionJournal({
      bucket: 'fss-suppression-journal-test',
      putObject: async () => await Promise.resolve('written'),
    });
    expect(durable.description).toBe('s3');
    expect(requireDurableJournal(durable)).toBe(durable.journal);
  });

  it('puts nothing in the body that is not an identifier or a code', () => {
    const body = JSON.parse(
      journalBody({
        eventId: 'sup_jkl',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        scope: 'handle',
        canonicalKey: '+14015550123',
        canonicalizerVersion: 'e164-lower.1',
        source: 'prospect_opt_out',
        actorUserId: null,
        commandId: null,
        supersedesEventId: null,
        supersessionReason: null,
        recordedAt: '2026-09-16T14:00:00.000Z',
      }),
    ) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'actorUserId',
      'canonicalKey',
      'canonicalizerVersion',
      'commandId',
      'eventId',
      'recordedAt',
      'schema',
      'scope',
      'source',
      'supersedesEventId',
      'supersessionReason',
      'workspaceId',
    ]);
  });
});
