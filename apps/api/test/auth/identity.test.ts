import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessionGrantSchema } from '@fss/contracts';
import {
  authenticate,
  canonicalJson,
  claimSignIn,
  decideSensitiveRead,
  handleCallback,
  parseAccessToken,
  parseRefreshCredential,
  payloadHashOf,
  recordSensitiveRead,
  renewSession,
  runCommand,
  sha256Hex,
  startSignIn,
  validateIdToken,
  type AuthenticatedPrincipal,
  type SessionGrant,
} from '../../src/auth/index.ts';
import { route } from '../../src/index.ts';
import {
  CURRENT_CLIENT_VERSION,
  OUTDATED_CLIENT_VERSION,
  createAuthFixture,
  nonceOf,
  stateOf,
  type AuthFixture,
  type SeededWorkspace,
} from '../support/authFixture.ts';

/**
 * The rest of specification 5: JWKS caching and rotation, the grant's shape, command
 * receipts, the read matrix, the last-active-admin protection, and two workspaces
 * with colliding identifiers that must never see each other.
 */

let fixture: AuthFixture;
let baseline: Date;

beforeAll(async () => {
  fixture = await createAuthFixture();
  baseline = fixture.deps.now();
});

beforeEach(() => {
  fixture.setNow(baseline);
});

afterAll(async () => {
  await fixture.stop();
});

async function signIn(
  workspace: SeededWorkspace,
  member: { readonly googleSub: string; readonly email: string },
  options: { readonly deviceLabel?: string } = {},
): Promise<SessionGrant> {
  const started = await startSignIn(fixture.deps, {
    workspaceId: workspace.workspaceId,
    deviceLabel: options.deviceLabel ?? fixture.collidingDeviceLabel,
    clientVersion: CURRENT_CLIENT_VERSION,
  });
  if (!started.started) throw new Error(`sign-in did not start: ${started.refusal}`);
  const code = `code-${randomUUID()}`;
  fixture.google.issueCode(code);
  fixture.google.nextIdToken(
    fixture.google.signIdToken({
      sub: member.googleSub,
      email: member.email,
      hd: fixture.hostedDomain,
      nonce: nonceOf(started.authorizationUrl),
    }),
  );
  const callback = await handleCallback(fixture.deps, { state: stateOf(started.authorizationUrl), code });
  if (!callback.authenticated) throw new Error(`callback refused: ${callback.refusal}`);
  const claimed = await claimSignIn(fixture.deps, {
    handoffSecret: started.handoffSecret,
    clientVersion: CURRENT_CLIENT_VERSION,
  });
  if (!claimed.claimed) throw new Error(`claim refused: ${claimed.refusal}`);
  return claimed.grant;
}

async function principalOf(grant: SessionGrant): Promise<AuthenticatedPrincipal> {
  const outcome = await authenticate(fixture.deps, `Bearer ${grant.accessToken}`);
  if (!outcome.authenticated) throw new Error(`not authenticated: ${outcome.refusal}`);
  return outcome.principal;
}

describe('the sign-in grant', () => {
  it('hands the Mac everything it needs exactly once, in the contract shape', async () => {
    const grant = await signIn(fixture.alpha, fixture.alpha.admin);
    expect(() => sessionGrantSchema.parse(grant)).not.toThrow();
    expect(grant.role).toBe('admin');
    expect(parseAccessToken(grant.accessToken)?.workspaceId).toBe(fixture.alpha.workspaceId);
    expect(parseRefreshCredential(grant.refreshCredential)).toMatchObject({
      workspaceId: fixture.alpha.workspaceId,
      deviceId: grant.deviceId,
      generation: 1,
    });
  });

  it('stores only digests: no plaintext credential reaches any row', async () => {
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson);
    for (const [table, column] of [
      ['sessions', 'access_token_hash'],
      ['device_refresh_credentials', 'secret_hash'],
      ['devices', 'secret_hash'],
    ] as const) {
      const { rows } = await fixture.db.query<{ value: string }>(
        `SELECT ${column} AS value FROM ${table} WHERE workspace_id = $1`,
        [grant.workspaceId],
      );
      for (const row of rows) expect(row.value).toMatch(/^[0-9a-f]{64}$/);
    }
    const dump = JSON.stringify(
      (await fixture.db.query('SELECT * FROM sessions WHERE workspace_id = $1', [grant.workspaceId])).rows,
    );
    for (const secret of [grant.accessToken, grant.refreshCredential, grant.deviceSecret]) {
      expect(dump).not.toContain(secret);
    }
  });

  it('refuses a handoff secret that was never issued, and one already claimed', async () => {
    const started = await startSignIn(fixture.deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    if (!started.started) throw new Error('sign-in did not start');

    // Before the browser has come back there is nothing to claim.
    expect(
      await claimSignIn(fixture.deps, {
        handoffSecret: started.handoffSecret,
        clientVersion: CURRENT_CLIENT_VERSION,
      }),
    ).toEqual({ claimed: false, refusal: 'handoff_unknown' });

    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson);
    expect(grant.deviceId).toBeTruthy();
  });

  it('refuses a claim after the authorization request expired', async () => {
    const started = await startSignIn(fixture.deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    if (!started.started) throw new Error('sign-in did not start');
    const code = `code-${randomUUID()}`;
    fixture.google.issueCode(code);
    fixture.google.nextIdToken(
      fixture.google.signIdToken({
        sub: fixture.alpha.salesperson.googleSub,
        email: fixture.alpha.salesperson.email,
        hd: fixture.hostedDomain,
        nonce: nonceOf(started.authorizationUrl),
      }),
    );
    expect((await handleCallback(fixture.deps, { state: stateOf(started.authorizationUrl), code })).authenticated).toBe(
      true,
    );

    fixture.advance(601_000);
    expect(
      await claimSignIn(fixture.deps, {
        handoffSecret: started.handoffSecret,
        clientVersion: CURRENT_CLIENT_VERSION,
      }),
    ).toEqual({ claimed: false, refusal: 'handoff_expired' });
  });

  it('refuses a callback whose authorization request has expired', async () => {
    const started = await startSignIn(fixture.deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    if (!started.started) throw new Error('sign-in did not start');
    fixture.advance(601_000);
    expect(await handleCallback(fixture.deps, { state: stateOf(started.authorizationUrl), code: 'x' })).toEqual({
      authenticated: false,
      refusal: 'authorization_request_expired',
    });
  });
});

describe('id-token validation against a rotating key set', () => {
  it('follows a key rotation without being told, and refuses an unknown kid', async () => {
    // Warm the cache, then prove a second sign-in reuses it rather than fetching again.
    await signIn(fixture.alpha, fixture.alpha.salesperson);
    const cached = fixture.google.jwksFetches();
    expect(cached).toBeGreaterThan(0);
    await signIn(fixture.alpha, fixture.alpha.salesperson);
    expect(fixture.google.jwksFetches()).toBe(cached);

    // Google rotates. The next token names a kid the cache has never seen, and the
    // client refreshes once rather than refusing.
    fixture.google.rotateKey();
    fixture.advance(61_000);
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson);
    expect(grant.deviceId).toBeTruthy();
    expect(fixture.google.jwksFetches()).toBeGreaterThan(cached);
  });

  it('refuses an unsigned token, a wrong signature, and an expired one', async () => {
    const started = await startSignIn(fixture.deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    if (!started.started) throw new Error('sign-in did not start');
    const nonce = nonceOf(started.authorizationUrl);
    const expectedNonceHash = sha256Hex(nonce);
    // The digest the row holds is the digest of the nonce in the authorization URL.
    const stored = await fixture.db.query<{ nonce_hash: string }>(
      'SELECT nonce_hash FROM oidc_authorization_requests WHERE state_hash = $1',
      [sha256Hex(stateOf(started.authorizationUrl))],
    );
    expect(stored.rows[0]?.nonce_hash).toBe(expectedNonceHash);

    const now = fixture.deps.now();
    const cases = [
      [fixture.google.signIdToken({ nonce }, { algorithm: 'none' }), 'unsupported_algorithm'],
      [fixture.google.signIdToken({ nonce }, { kid: 'a-kid-nobody-published' }), 'unknown_signing_key'],
      [
        fixture.google.signIdToken({ nonce, exp: Math.floor(now.getTime() / 1000) - 3600 }),
        'token_expired',
      ],
      [
        fixture.google.signIdToken({ nonce, iat: Math.floor(now.getTime() / 1000) + 7200 }),
        'token_issued_in_future',
      ],
      [fixture.google.signIdToken({ nonce, email_verified: false }), 'email_unverified'],
      [fixture.google.signIdToken({ nonce, hd: 'someone-else.example' }), 'hosted_domain_mismatch'],
      ['not.a.token', 'malformed_token'],
    ] as const;

    for (const [token, refusal] of cases) {
      const outcome = await validateIdToken({
        token,
        config: fixture.deps.config.oidc,
        google: fixture.deps.google,
        now,
        expectedNonceHash,
      });
      expect(outcome, refusal).toEqual({ valid: false, refusal });
    }
  });
});

describe('command receipts', () => {
  it('refuses a replay whose payload changed, and one from another device', async () => {
    const first = await signIn(fixture.alpha, fixture.alpha.salesperson);
    const second = await signIn(fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'A second Mac' });
    const firstPrincipal = await principalOf(first);
    const secondPrincipal = await principalOf(second);
    const commandId = `cmd-${randomUUID()}`;

    const accepted = await runCommand(
      fixture.deps,
      firstPrincipal,
      { commandId, kind: 'firm.assigned', payload: { firmId: 'f-1' }, clientVersion: CURRENT_CLIENT_VERSION },
      async () => ({ status: 'accepted', result: { assigned: 'f-1' } }),
    );
    expect(accepted).toEqual({ status: 'accepted', result: { assigned: 'f-1' }, replayed: false });

    expect(
      await runCommand(
        fixture.deps,
        firstPrincipal,
        { commandId, kind: 'firm.assigned', payload: { firmId: 'f-2' }, clientVersion: CURRENT_CLIENT_VERSION },
        async () => ({ status: 'accepted', result: { assigned: 'f-2' } }),
      ),
    ).toMatchObject({ status: 'refused', reason: 'command_payload_mismatch' });

    expect(
      await runCommand(
        fixture.deps,
        secondPrincipal,
        { commandId, kind: 'firm.assigned', payload: { firmId: 'f-1' }, clientVersion: CURRENT_CLIENT_VERSION },
        async () => ({ status: 'accepted', result: { assigned: 'f-1' } }),
      ),
    ).toMatchObject({ status: 'refused', reason: 'command_device_mismatch' });
  });

  it('replays a refusal as a refusal, not as a fresh attempt', async () => {
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson);
    const principal = await principalOf(grant);
    const commandId = `cmd-${randomUUID()}`;
    let attempts = 0;
    const request = {
      commandId,
      kind: 'firm.assigned',
      payload: { firmId: 'f-9' },
      clientVersion: CURRENT_CLIENT_VERSION,
    };
    const work = async (): Promise<{ status: 'refused'; reason: string }> => {
      attempts += 1;
      return { status: 'refused', reason: 'firm_suppressed' };
    };
    expect(await runCommand(fixture.deps, principal, request, work)).toEqual({
      status: 'refused',
      reason: 'firm_suppressed',
      replayed: false,
    });
    expect(await runCommand(fixture.deps, principal, request, work)).toEqual({
      status: 'refused',
      reason: 'firm_suppressed',
      replayed: true,
    });
    expect(attempts).toBe(1);
  });

  it('keeps no actionable result for a dial authorization replay', async () => {
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson);
    const principal = await principalOf(grant);
    const commandId = `cmd-${randomUUID()}`;
    const request = {
      commandId,
      kind: 'authorize_dial',
      payload: { routeId: 'r-1' },
      clientVersion: CURRENT_CLIENT_VERSION,
    };
    expect(
      await runCommand(fixture.deps, principal, request, async () => ({
        status: 'accepted',
        result: { ticket: 'one-use-ticket' },
      })),
    ).toMatchObject({ status: 'accepted', replayed: false });

    const { rows } = await fixture.db.query<{ result: unknown }>(
      'SELECT result FROM command_receipts WHERE workspace_id = $1 AND command_id = $2',
      [grant.workspaceId, commandId],
    );
    expect(rows[0]?.result).toBeNull();

    // The replay answers from a receipt that carries nothing to act on.
    const replay = await runCommand(fixture.deps, principal, request, async () => ({
      status: 'accepted',
      result: { ticket: 'another-ticket' },
    }));
    expect(replay).toEqual({ status: 'accepted', result: null, replayed: true });
  });

  it('hashes a payload independently of key order', () => {
    expect(payloadHashOf({ a: 1, b: [2, 3] })).toBe(payloadHashOf({ b: [2, 3], a: 1 }));
    expect(payloadHashOf({ a: 1 })).not.toBe(payloadHashOf({ a: 2 }));
    // Arrays keep their order: an array's order is data.
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('two workspaces with colliding identifiers', () => {
  it('keeps devices, sessions, receipts and command ids to their own workspace', async () => {
    const inAlpha = await signIn(fixture.alpha, fixture.alpha.salesperson);
    const inBeta = await signIn(fixture.beta, fixture.beta.salesperson);
    // The two salespeople share a display email and both Macs carry the same label.
    expect(fixture.alpha.salesperson.email).toBe(fixture.beta.salesperson.email);
    expect(inAlpha.workspaceId).not.toBe(inBeta.workspaceId);
    expect(inAlpha.userId).not.toBe(inBeta.userId);

    const commandId = fixture.collidingCommandId;
    for (const grant of [inAlpha, inBeta]) {
      const principal = await principalOf(grant);
      const outcome = await runCommand(
        fixture.deps,
        principal,
        { commandId, kind: 'firm.assigned', payload: { firmId: 'shared' }, clientVersion: CURRENT_CLIENT_VERSION },
        async () => ({ status: 'accepted', result: { workspaceId: grant.workspaceId } }),
      );
      expect(outcome).toEqual({ status: 'accepted', result: { workspaceId: grant.workspaceId }, replayed: false });
    }

    // Alpha's access token names alpha, so beta's row is invisible to it and the
    // reverse — even though both receipts carry the same command id.
    const { rows } = await fixture.db.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM command_receipts WHERE command_id = $1 ORDER BY workspace_id',
      [commandId],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.workspace_id))).toEqual(
      new Set([inAlpha.workspaceId, inBeta.workspaceId]),
    );

    // Beta's refresh credential cannot renew alpha's device: the credential names its
    // own workspace, and the composite key means there is no row at the crossing.
    const crossed = parseRefreshCredential(inBeta.refreshCredential);
    expect(crossed).not.toBeNull();
    if (crossed !== null) {
      const forged = `fssr1.${inAlpha.workspaceId}.${crossed.deviceId}.${String(crossed.generation)}.${inBeta.refreshCredential.split('.')[4] ?? ''}`;
      expect(await renewSession(fixture.deps, { refreshCredential: forged, clientVersion: CURRENT_CLIENT_VERSION })).toEqual(
        { renewed: false, refusal: 'credential_unknown' },
      );
    }
  });
});

describe('the read matrix and its audit hook', () => {
  it('audits an admin reading a row they do not own, and not one they do', () => {
    expect(
      decideSensitiveRead({
        kind: 'message_body',
        actorRole: 'admin',
        actorIsAssignee: false,
        actorIsMailboxOwner: false,
      }),
    ).toEqual({ permitted: true, audited: true, visibility: 'assigned_or_admin' });

    expect(
      decideSensitiveRead({
        kind: 'message_body',
        actorRole: 'admin',
        actorIsAssignee: true,
        actorIsMailboxOwner: false,
      }),
    ).toEqual({ permitted: true, audited: false, visibility: 'assigned_or_admin' });

    expect(
      decideSensitiveRead({
        kind: 'mailbox_diagnostics',
        actorRole: 'salesperson',
        actorIsAssignee: true,
        actorIsMailboxOwner: false,
      }),
    ).toEqual({ permitted: false, visibility: 'mailbox_owner_or_admin' });
  });

  it('writes the audit event when it says it will', async () => {
    const grant = await signIn(fixture.alpha, fixture.alpha.admin);
    const before = await auditCount(grant.workspaceId, 'read.message_body');
    const decision = await recordSensitiveRead(fixture.db, {
      workspaceId: grant.workspaceId,
      actorUserId: grant.userId,
      actorRole: 'admin',
      kind: 'message_body',
      actorIsAssignee: false,
      actorIsMailboxOwner: false,
      subjectKind: 'message',
      subjectId: 'message-1',
    });
    expect(decision).toMatchObject({ permitted: true, audited: true });
    expect(await auditCount(grant.workspaceId, 'read.message_body')).toBe(before + 1);
  });
});

async function auditCount(workspaceId: string, action: string): Promise<number> {
  const { rows } = await fixture.db.query<{ count: string }>(
    'SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1 AND action = $2',
    [workspaceId, action],
  );
  return Number(rows[0]?.count ?? '0');
}

describe('the routes', () => {
  const options = (): Parameters<typeof route>[2] => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
  });

  it('publishes the client-version notice without a session, at any version', async () => {
    const result = await route('GET', '/auth/client-version', options());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ supported: { minimum: '1.2.0', maximum: '1.4.0' } });
  });

  it('refuses a sign-in start from an outdated client with the upgrade instruction', async () => {
    const result = await route('POST', '/auth/sign-in/start', options(), {
      body: {
        workspaceId: fixture.alpha.workspaceId,
        deviceLabel: fixture.collidingDeviceLabel,
        clientVersion: OUTDATED_CLIENT_VERSION,
      },
    });
    expect(result.status).toBe(426);
    expect(result.body).toMatchObject({ error: 'client_upgrade_required' });
  });

  it('refuses every admin route without a session and to a salesperson', async () => {
    const salesperson = await signIn(fixture.alpha, fixture.alpha.salesperson);
    for (const path of ['/admin/memberships', '/admin/devices']) {
      expect((await route('GET', path, options())).status, path).toBe(401);
      expect(
        (await route('GET', path, options(), { headers: { authorization: `Bearer ${salesperson.accessToken}` } }))
          .status,
        path,
      ).toBe(403);
    }
  });

  it('lists memberships and devices as redacted views with no secret material', async () => {
    const admin = await signIn(fixture.alpha, fixture.alpha.admin);
    const headers = { authorization: `Bearer ${admin.accessToken}` };
    const memberships = await route('GET', '/admin/memberships', options(), { headers });
    expect(memberships.status).toBe(200);
    const devices = await route('GET', '/admin/devices', options(), { headers });
    expect(devices.status).toBe(200);
    const serialized = JSON.stringify(devices.body);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain(admin.deviceSecret);
  });

  it('refuses to deactivate or demote the last active admin', async () => {
    const admin = await signIn(fixture.beta, fixture.beta.admin);
    const headers = { authorization: `Bearer ${admin.accessToken}` };

    const demote = await route('POST', '/admin/memberships/role', options(), {
      headers,
      body: {
        commandId: `cmd-${randomUUID()}`,
        clientVersion: CURRENT_CLIENT_VERSION,
        userId: admin.userId,
        role: 'salesperson',
      },
    });
    expect(demote.body).toMatchObject({ status: 'refused', reason: 'last_active_admin' });

    const deactivate = await route('POST', '/admin/memberships/deactivate', options(), {
      headers,
      body: { commandId: `cmd-${randomUUID()}`, clientVersion: CURRENT_CLIENT_VERSION, userId: admin.userId },
    });
    expect(deactivate.body).toMatchObject({ status: 'refused', reason: 'last_active_admin' });

    // The workspace still has its admin, and the refusal was recorded as a receipt.
    const still = await authenticate(fixture.deps, `Bearer ${admin.accessToken}`);
    expect(still.authenticated).toBe(true);
  });

  it('revokes a device through the admin command and ends its sessions', async () => {
    const admin = await signIn(fixture.alpha, fixture.alpha.admin);
    const target = await signIn(fixture.alpha, fixture.alpha.salesperson);
    const revoke = await route('POST', '/admin/devices/revoke', options(), {
      headers: { authorization: `Bearer ${admin.accessToken}` },
      body: { commandId: `cmd-${randomUUID()}`, clientVersion: CURRENT_CLIENT_VERSION, deviceId: target.deviceId },
    });
    expect(revoke.body).toMatchObject({ status: 'accepted' });
    expect(await authenticate(fixture.deps, `Bearer ${target.accessToken}`)).toEqual({
      authenticated: false,
      refusal: 'device_revoked',
    });
    expect(
      await renewSession(fixture.deps, {
        refreshCredential: target.refreshCredential,
        clientVersion: CURRENT_CLIENT_VERSION,
      }),
    ).toEqual({ renewed: false, refusal: 'device_revoked' });
  });

  it('ends the session on sign-out and leaves the device registered', async () => {
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson);
    const signedOut = await route('POST', '/auth/sign-out', options(), {
      headers: { authorization: `Bearer ${grant.accessToken}` },
    });
    expect(signedOut.status).toBe(200);
    expect(await authenticate(fixture.deps, `Bearer ${grant.accessToken}`)).toEqual({
      authenticated: false,
      refusal: 'session_ended',
    });
    const { rows } = await fixture.db.query<{ status: string }>('SELECT status FROM devices WHERE id = $1', [
      grant.deviceId,
    ]);
    expect(rows[0]?.status).toBe('active');
  });

  it("puts lane G5's job and alert routes behind an admin session", async () => {
    const salesperson = await signIn(fixture.alpha, fixture.alpha.salesperson);
    const admin = await signIn(fixture.alpha, fixture.alpha.admin);

    for (const path of ['/admin/jobs/dead', '/admin/alerts']) {
      // No session at all is 401; a salesperson's is 403 — and both bodies say the
      // same redacted thing, so neither tells a salesperson the endpoint exists.
      const anonymous = await route('GET', path, options());
      expect(anonymous.status, path).toBe(401);
      const asSalesperson = await route('GET', path, options(), {
        headers: { authorization: `Bearer ${salesperson.accessToken}` },
      });
      expect(asSalesperson.status, path).toBe(403);
      expect(asSalesperson.body).toEqual(anonymous.body);
      const asAdmin = await route('GET', path, options(), {
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(asAdmin.status, path).toBe(200);
    }
  });

  it('still refuses an unknown path rather than falling through', async () => {
    expect(await route('GET', '/auth/whatever', options())).toMatchObject({ status: 404 });
    // `/firms` was this example until lane G3a mounted it. An unmounted path is the
    // point; a mounted one now answers 401, which is a different (and correct) thing.
    expect(await route('GET', '/nothing-mounted-here', options())).toMatchObject({ status: 404 });
  });
});
