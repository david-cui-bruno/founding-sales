import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callingIdentityDtoSchema, callingIdentityListSchema } from '@fss/contracts';
import { POSTURE_STATEMENT_KEYS } from '@fss/domain';
import { repositoryContext, workspaceScope } from '@fss/domain/db';
import { buildTodaySnapshot, businessDateOf, promoteTodayItem } from '@fss/domain/today';
import type { AddressInfo } from 'node:net';
import { poolConnections } from '../src/bootstrap/connections.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { createApiServer, dispatch, refusalCodeOf, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { testRequestPool } from './support/poolFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The calling-number endpoints, through the real dispatcher with real sessions
 * (specification 9.1, 9.2; lane g60).
 *
 * The rules have their own tests against a real PostgreSQL in `@fss/domain`
 * (`test/policy/callingIdentities.test.ts`). What is proved here is the wiring, and
 * three pieces of it are this lane's alone:
 *
 *   * who may do what is answered by the domain from the session, and every refusal is
 *     a 409 with a code from `CALLING_IDENTITY_REFUSAL_CODES` — never a hold, never a
 *     403 that would say a colleague's number exists;
 *   * the attestation is a receipted command, so a retried press returns the first
 *     answer rather than attesting twice (5.3);
 *   * **the whole path works end to end**: a salesperson with no number has a Today
 *     card with no calling identity; after registering and attesting through these
 *     routes the same card carries it, and `/dial/authorize` accepts it at 9.2's
 *     second step. That is production's gap on 24 September 2026, closed.
 *
 * No real number appears; the numbers are in the NANP 555-01XX fictional block.
 */
describe('the calling-number routes', () => {
  let fixture: AuthFixture;
  let salespersonToken: string;
  let adminToken: string;
  let strangerToken: string;
  let salespersonUserId: string;
  let firmId: string;
  let contactId: string;
  let routeId: string;
  let routeVersion: number;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: localNoopSuppressionJournal(),
  });

  const send = async (
    method: 'GET' | 'POST',
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method,
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: result.body as Record<string, unknown> };
  };
  const post = async (path: string, token: string | null, body: unknown) => await send('POST', path, token, body);

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  const resultOf = (answer: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answer.body['result'] ?? {}) as Record<string, unknown>;
  const identityOf = (answer: { body: Record<string, unknown> }) =>
    callingIdentityDtoSchema.parse(resultOf(answer)['identity']);

  const worker = () =>
    repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);

  const expandedIdentity = async (): Promise<unknown> => {
    const page = await post('/today/firm', salespersonToken, { firmId });
    expect(page.status).toBe(200);
    return page.body['callingIdentityId'];
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    salespersonUserId = fixture.alpha.salesperson.userId;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;

    const strangerSub = `sub-${randomUUID()}`;
    const strangerEmail = `stranger-identity@${fixture.hostedDomain}`;
    const stranger = await fixture.db.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, 'Stranger') RETURNING id",
      [strangerSub, strangerEmail],
    );
    await fixture.db.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [fixture.alpha.workspaceId, stranger.rows[0]?.id],
    );
    strangerToken = (
      await issueSessionFor(fixture, fixture.alpha, { googleSub: strangerSub, email: strangerEmail }, {
        deviceLabel: 'Other Mac',
      })
    ).accessToken;

    // A firm assigned to the salesperson, with a usable phone route, a resolved zone
    // and a posture: everything 9.2 needs except the calling identity.
    const created = await post(
      '/firms/create',
      adminToken,
      command({ name: 'Northwind Test Holdings', regionCode: 'RI', postalCode: '02903', assignedUserId: salespersonUserId }),
    );
    expect(created.status).toBe(200);
    firmId = String(resultOf(created)['id']);
    expect((await post('/firms/resolve-zone', adminToken, command({ firmId }))).status).toBe(200);
    const contact = await post('/contacts/create', salespersonToken, command({ firmId, fullName: 'Dana Example' }));
    expect(contact.status).toBe(200);
    contactId = String(resultOf(contact)['id']);
    const route = await post(
      '/contacts/routes/add',
      salespersonToken,
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

    // Today's card for that firm, so the expansion has something to carry.
    const clock = await fixture.db.query<{ now: Date }>('SELECT now() AS now');
    const now = (clock.rows[0]?.now ?? new Date()).toISOString();
    const businessDate = await businessDateOf(worker(), now);
    await buildTodaySnapshot(worker(), { businessDate, now });
    await promoteTodayItem(worker(), {
      businessDate,
      firmId,
      contactId,
      itemKey: 'step-execution:manual-call',
      kind: 'call_due',
      dueAt: now,
      sourceKind: 'step_execution',
      automated: false,
    });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses every path without a session', async () => {
    expect((await send('GET', '/calling-identities', null)).status).toBe(401);
    for (const path of ['/calling-identities/register', '/calling-identities/attest', '/calling-identities/disable']) {
      expect((await post(path, null, command())).status, path).toBe(401);
    }
  });

  it('refuses the wrong method and a malformed body', async () => {
    expect((await send('POST', '/calling-identities', salespersonToken, {})).status).toBe(405);
    expect((await send('GET', '/calling-identities/register', salespersonToken)).status).toBe(405);
    expect((await post('/calling-identities/register', salespersonToken, command({}))).status).toBe(400);
    // The attestation is a statement: without `attested: true` it is not one.
    expect(
      (await post('/calling-identities/attest', salespersonToken, command({ identityId: randomUUID() }))).status,
    ).toBe(400);
    expect(
      (await post('/calling-identities/attest', salespersonToken, command({ identityId: randomUUID(), attested: false })))
        .status,
    ).toBe(400);
  });

  it('takes a salesperson from no Call button to an authorized dial, through these routes alone', async () => {
    // Where production was: no number, and a card with nothing to call from.
    expect((await send('GET', '/calling-identities', salespersonToken)).body).toEqual({ identities: [] });
    expect(await expandedIdentity()).toBeNull();

    const registered = await post(
      '/calling-identities/register',
      salespersonToken,
      command({ e164: '+1 (401) 555-0150', label: 'Mobile' }),
    );
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    expect(resultOf(registered)['outcome']).toBe('created');
    const identity = identityOf(registered);
    expect(identity).toMatchObject({
      ownerUserId: salespersonUserId,
      e164: '+14015550150',
      label: 'Mobile',
      verificationStatus: 'unverified',
      enabled: false,
      usedForCalls: false,
    });
    // Registered is not verified: still no Call button, and the dial is refused at step 2.
    expect(await expandedIdentity()).toBeNull();
    const early = await post(
      '/dial/authorize',
      salespersonToken,
      command({ firmId, contactId, routeId, routeVersion, callingIdentityId: identity.id }),
    );
    expect(early.status).toBe(409);
    expect(early.body['reason']).toBe('identity_unverified');

    const attestCommand = command({ identityId: identity.id, attested: true });
    const attested = await post('/calling-identities/attest', salespersonToken, attestCommand);
    expect(attested.status, JSON.stringify(attested.body)).toBe(200);
    expect(identityOf(attested)).toMatchObject({
      verificationStatus: 'verified',
      enabled: true,
      verifiedByUserId: salespersonUserId,
      verificationMethod: 'owner_attestation',
      usedForCalls: true,
    });
    // A retried press is the same command: the receipt answers, nothing is attested twice.
    const replay = await post('/calling-identities/attest', salespersonToken, attestCommand);
    expect(replay.status).toBe(200);
    expect(replay.body['replayed']).toBe(true);
    const audits = await fixture.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_events WHERE action = 'calling_identity.attested' AND subject_id = $1",
      [identity.id],
    );
    expect(audits.rows[0]?.count).toBe('1');

    // The card now carries the number, and 9.2 gets past its second step.
    expect(await expandedIdentity()).toBe(identity.id);
    const dial = await post(
      '/dial/authorize',
      salespersonToken,
      command({ firmId, contactId, routeId, routeVersion, callingIdentityId: identity.id }),
    );
    if (dial.status === 200) {
      expect(resultOf(dial)['callingIdentityId']).toBe(identity.id);
    } else {
      // Whatever the clock says about the calling window; the window itself is tested in
      // `@fss/domain` where the instant is a parameter. Never an identity refusal.
      expect(dial.status).toBe(409);
      expect(dial.body['reason']).toBe('outside_calling_window');
    }

    const listed = callingIdentityListSchema.parse((await send('GET', '/calling-identities', salespersonToken)).body);
    expect(listed.identities.map(entry => [entry.id, entry.usedForCalls])).toEqual([[identity.id, true]]);
  });

  it('answers a refusal as a 409 with its code, and never lets one person act on another’s number', async () => {
    const invalid = await post('/calling-identities/register', salespersonToken, command({ e164: '401-555-0151' }));
    expect(invalid.status).toBe(409);
    expect(invalid.body['reason']).toBe('number_invalid');

    const forAdmin = await post(
      '/calling-identities/register',
      salespersonToken,
      command({ e164: '+14015550151', ownerUserId: fixture.alpha.admin.userId }),
    );
    expect(forAdmin.status).toBe(409);
    expect(forAdmin.body['reason']).toBe('admin_only');

    const taken = await post('/calling-identities/register', strangerToken, command({ e164: '+14015550150' }));
    expect(taken.status).toBe(409);
    expect(taken.body['reason']).toBe('number_registered_to_another');

    // The salesperson's own number is unknown to a colleague: not "not yours".
    const own = callingIdentityListSchema.parse((await send('GET', '/calling-identities', salespersonToken)).body);
    const id = own.identities[0]?.id ?? '';
    for (const path of ['/calling-identities/attest', '/calling-identities/disable']) {
      const answer = await post(path, strangerToken, command({ identityId: id, attested: true }));
      // `disable` takes no `attested`, and a strict body refuses the extra key.
      if (path.endsWith('disable')) {
        expect(answer.status).toBe(400);
        const plain = await post(path, strangerToken, command({ identityId: id }));
        expect(plain.status).toBe(409);
        expect(plain.body['reason']).toBe('identity_unknown');
      } else {
        expect(answer.status).toBe(409);
        expect(answer.body['reason']).toBe('identity_unknown');
      }
    }
    // And a colleague's list never contains it.
    expect((await send('GET', '/calling-identities', strangerToken)).body).toEqual({ identities: [] });
  });

  it('lets an admin register and attest a member’s number, recorded as the admin’s statement', async () => {
    const strangerId = (
      await fixture.db.query<{ user_id: string }>(
        `SELECT m.user_id FROM workspace_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND u.email LIKE 'stranger-identity@%'`,
        [fixture.alpha.workspaceId],
      )
    ).rows[0]?.user_id;
    const registered = await post(
      '/calling-identities/register',
      adminToken,
      command({ e164: '+14015550152', ownerUserId: strangerId }),
    );
    expect(registered.status).toBe(200);
    const attested = await post(
      '/calling-identities/attest',
      adminToken,
      command({ identityId: identityOf(registered).id, attested: true }),
    );
    expect(attested.status).toBe(200);
    expect(identityOf(attested)).toMatchObject({
      ownerUserId: strangerId,
      verifiedByUserId: fixture.alpha.admin.userId,
      verificationMethod: 'admin_attestation',
    });
    // The admin's own list is the admin's own numbers, not the member's.
    expect((await send('GET', '/calling-identities', adminToken)).body).toEqual({ identities: [] });
  });

  it('retires a number: the card stops offering it and the row stays', async () => {
    const own = callingIdentityListSchema.parse((await send('GET', '/calling-identities', salespersonToken)).body);
    const id = own.identities[0]?.id ?? '';
    const retired = await post('/calling-identities/disable', salespersonToken, command({ identityId: id }));
    expect(retired.status).toBe(200);
    expect(identityOf(retired)).toMatchObject({ enabled: false, usedForCalls: false });
    expect(identityOf(retired).disabledAt).not.toBeNull();
    expect(await expandedIdentity()).toBeNull();
    const after = callingIdentityListSchema.parse((await send('GET', '/calling-identities', salespersonToken)).body);
    expect(after.identities.map(entry => [entry.id, entry.enabled])).toEqual([[id, false]]);
  });

  it('logs a refusal with the code its body carries, over the real server, and never the number typed (lane g69)', async () => {
    // Production logged `POST /calling-identities/register → 409` on 25 September 2026
    // and nothing else, and a 409 here is any of five refusals. The line now carries
    // the body's code beside the status the Refusals metric counts by.
    const log = recordingLogger();
    // The server takes connections, not a session (lane g75): a pool over this file's database.
    const pool = testRequestPool(fixture.database);
    const { session: _session, ...serverOptions } = options();
    const server = createApiServer({ ...serverOptions, connections: poolConnections(pool), log });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const register = async (body: unknown): Promise<number> =>
        (
          await fetch(`http://127.0.0.1:${String(port)}/calling-identities/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${salespersonToken}` },
            body: JSON.stringify(body),
          })
        ).status;
      expect(await register(command({ e164: '401-555-0153' }))).toBe(409);
      expect(await register(command({}))).toBe(400);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await pool.end();
    }

    const refusals = log.lines.filter(line => line['event'] === 'refusal');
    expect(refusals).toEqual([
      expect.objectContaining({ reason: '409', code: 'number_invalid', path: '/calling-identities/register' }),
      expect.objectContaining({ reason: '400', code: 'malformed_body', path: '/calling-identities/register' }),
    ]);
    // Nothing the person typed, in any spelling, and not the session that sent it.
    const text = JSON.stringify(log.lines);
    for (const typed of ['401-555-0153', '4015550153', '555-0153', salespersonToken]) expect(text).not.toContain(typed);
  });

  it('takes a refusal code only in the shape of one', () => {
    expect(refusalCodeOf({ status: 'refused', replayed: false, reason: 'number_invalid' })).toBe('number_invalid');
    expect(refusalCodeOf({ error: 'not_found', message: 'No such endpoint.' })).toBe('not_found');
    // `reason` first, as the desktop's `refusalOf` reads it.
    expect(refusalCodeOf({ reason: 'admin_only', error: 'forbidden' })).toBe('admin_only');
    for (const body of [
      { reason: '+14015550150' },
      { reason: 'Callie cannot call from that.' },
      { error: 'NUMBER_INVALID' },
      { reason: 42 },
      { reason: 'x'.repeat(81) },
      null,
      'number_invalid',
      [],
    ]) {
      expect(refusalCodeOf(body)).toBeNull();
    }
  });
});
