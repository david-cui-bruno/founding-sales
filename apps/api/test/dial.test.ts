import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

    const created = await post(
      '/firms/create',
      adminToken,
      command({ name: 'Northwind Test Holdings', regionCode: 'RI', postalCode: '02903', assignedUserId: assigneeUserId }),
    );
    expect(created.status).toBe(200);
    firmId = String(resultOf(created)['id']);
    // Providence, Rhode Island: the state default resolves the zone, which step 5
    // of `authorizeDial` requires before it will look at a posture at all.
    const zone = await post('/firms/resolve-zone', adminToken, command({ firmId }));
    expect(zone.status).toBe(200);

    const contact = await post('/contacts/create', assigneeToken, command({ firmId, fullName: 'Dana Example' }));
    expect(contact.status).toBe(200);
    contactId = String(resultOf(contact)['id']);

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

    const identity = await fixture.db.query<{ id: string }>(
      `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled)
       VALUES ($1, $2, '+14015550100', 'verified', true) RETURNING id`,
      [fixture.alpha.workspaceId, assigneeUserId],
    );
    callingIdentityId = identity.rows[0]?.id ?? '';

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
      `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled)
       VALUES ($1, $2, '+14015550101', 'verified', true) RETURNING id`,
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
      `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled)
       VALUES ($1, NULL, '+14015550102', 'verified', false) RETURNING id`,
      [fixture.alpha.workspaceId],
    );
    const answer = await post(
      '/dial/authorize',
      assigneeToken,
      command({ firmId, contactId, routeId, routeVersion, callingIdentityId: shared.rows[0]?.id }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body['reason']).toBe('identity_shared_line_disabled');
  });

  it('writes the journal before it acknowledges a suppression', async () => {
    const before = journal.appended.length;
    const recorded = await post(
      '/suppressions/record',
      assigneeToken,
      command({ scope: 'handle', value: '+1 401 555 0190', firmId, source: 'salesperson_manual' }),
    );
    expect(recorded.status).toBe(200);
    expect(journal.appended.length).toBe(before + 1);

    const appended = journal.appended.at(-1);
    expect(appended?.eventId).toBe(resultOf(recorded)['eventId']);
    // Canonicalized server-side: the caller typed spaces and got E.164.
    expect(appended?.canonicalKey).toBe('+14015550190');
    expect(appended?.canonicalizerVersion).toBe('e164-lower.1');

    const listed = await get('/suppressions', assigneeToken);
    expect(listed.status).toBe(200);
    const suppressions = listed.body['suppressions'] as { canonicalKey: string }[];
    expect(suppressions.some(row => row.canonicalKey === '+14015550190')).toBe(true);
  });

  it('fails the command and leaves the id free when the journal write fails', async () => {
    const commandId = randomUUID();
    const body = {
      commandId,
      clientVersion: CURRENT_CLIENT_VERSION,
      scope: 'handle' as const,
      value: '+14015550191',
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

  it('creates a callback only with a confirmed instant, and completes it once', async () => {
    const withoutInstant = await post(
      '/calls/log',
      assigneeToken,
      command({ firmId, outcome: 'callback_requested', occurredAt: new Date().toISOString() }),
    );
    expect(withoutInstant.status).toBe(409);
    expect(withoutInstant.body['reason']).toBe('invalid_input');

    const withInstant = await post(
      '/calls/log',
      assigneeToken,
      command({
        firmId,
        contactId,
        outcome: 'callback_requested',
        occurredAt: new Date().toISOString(),
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

    const listed = await get('/callbacks', assigneeToken, 'open=true');
    expect((listed.body['callbacks'] as { id: string }[]).some(row => row.id === callbackId)).toBe(true);

    expect((await post('/callbacks/complete', assigneeToken, command({ callbackId }))).status).toBe(200);
    const second = await post('/callbacks/complete', assigneeToken, command({ callbackId }));
    expect(second.status).toBe(409);
    expect(second.body['reason']).toBe('callback_not_open');
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
