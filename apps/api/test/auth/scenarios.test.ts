import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticate,
  claimSignIn,
  handleCallback,
  renewSession,
  runCommand,
  startSignIn,
  type SessionGrant,
} from '../../src/auth/index.ts';
import {
  CURRENT_CLIENT_VERSION,
  OUTDATED_CLIENT_VERSION,
  createAuthFixture,
  nonceOf,
  stateOf,
  type AuthFixture,
} from '../support/authFixture.ts';

/**
 * Appendix G scenarios 23, 24 and 40, against a real PostgreSQL 16 and a local
 * OpenID Connect provider whose keys are generated when the test starts.
 *
 * These were written before any of `src/auth` existed; the first run failed at the
 * import, which is the RED this lane started from.
 */

let fixture: AuthFixture;
let baseline: Date;

beforeAll(async () => {
  fixture = await createAuthFixture();
  baseline = fixture.deps.now();
});

// Several of these move the clock by a month. Resetting here rather than at the end
// of each test means a failing assertion cannot leave the next test in the future.
beforeEach(() => {
  fixture.setNow(baseline);
});

afterAll(async () => {
  await fixture.stop();
});

/** Drive a whole sign-in for one member and return the grant the desktop app would store. */
async function signIn(
  member: { readonly userId: string; readonly googleSub: string; readonly email: string },
  options: { readonly workspaceId?: string; readonly clientVersion?: string } = {},
): Promise<SessionGrant> {
  const workspaceId = options.workspaceId ?? fixture.alpha.workspaceId;
  const started = await startSignIn(fixture.deps, {
    workspaceId,
    deviceLabel: fixture.collidingDeviceLabel,
    clientVersion: options.clientVersion ?? CURRENT_CLIENT_VERSION,
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
    clientVersion: options.clientVersion ?? CURRENT_CLIENT_VERSION,
  });
  if (!claimed.claimed) throw new Error(`claim refused: ${claimed.refusal}`);
  return claimed.grant;
}

describe('Appendix G 23: OIDC state, nonce, code and token-audience replay are refused', () => {
  it('refuses a callback whose state was never issued', async () => {
    const outcome = await handleCallback(fixture.deps, { state: 'not-a-state-we-issued', code: 'anything' });
    expect(outcome).toEqual({ authenticated: false, refusal: 'authorization_request_unknown' });
  });

  it('refuses the second callback that carries a state already consumed', async () => {
    const started = await startSignIn(fixture.deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    expect(started.started).toBe(true);
    if (!started.started) return;

    const state = stateOf(started.authorizationUrl);
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
    const first = await handleCallback(fixture.deps, { state, code });
    expect(first.authenticated).toBe(true);

    // The state row was consumed by the first callback, so the replay finds nothing —
    // and the replay never reaches Google, because there is no verifier to present.
    const exchangesBefore = fixture.google.tokenExchanges().length;
    const replay = await handleCallback(fixture.deps, { state, code });
    expect(replay).toEqual({ authenticated: false, refusal: 'authorization_request_unknown' });
    expect(fixture.google.tokenExchanges().length).toBe(exchangesBefore);
  });

  it('refuses an id token whose nonce belongs to a different authorization request', async () => {
    const mine = await startSignIn(fixture.deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    const other = await startSignIn(fixture.deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    if (!mine.started || !other.started) throw new Error('sign-in did not start');

    const code = `code-${randomUUID()}`;
    fixture.google.issueCode(code);
    fixture.google.nextIdToken(
      fixture.google.signIdToken({
        sub: fixture.alpha.salesperson.googleSub,
        email: fixture.alpha.salesperson.email,
        hd: fixture.hostedDomain,
        nonce: nonceOf(other.authorizationUrl),
      }),
    );
    const outcome = await handleCallback(fixture.deps, { state: stateOf(mine.authorizationUrl), code });
    expect(outcome).toEqual({ authenticated: false, refusal: 'nonce_mismatch' });
  });

  it('refuses a replayed authorization code, because Google answers invalid_grant', async () => {
    const first = await startSignIn(fixture.deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    const second = await startSignIn(fixture.deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    if (!first.started || !second.started) throw new Error('sign-in did not start');

    const code = `code-${randomUUID()}`;
    fixture.google.issueCode(code);
    fixture.google.nextIdToken(
      fixture.google.signIdToken({
        sub: fixture.alpha.salesperson.googleSub,
        email: fixture.alpha.salesperson.email,
        hd: fixture.hostedDomain,
        nonce: nonceOf(first.authorizationUrl),
      }),
    );
    expect((await handleCallback(fixture.deps, { state: stateOf(first.authorizationUrl), code })).authenticated).toBe(
      true,
    );

    const replay = await handleCallback(fixture.deps, { state: stateOf(second.authorizationUrl), code });
    expect(replay).toEqual({ authenticated: false, refusal: 'token_exchange_failed' });
  });

  it('refuses an id token minted for another audience or another authorized party', async () => {
    for (const [claims, refusal] of [
      [{ aud: 'some-other-client.apps.googleusercontent.test' }, 'audience_mismatch'],
      [{ azp: 'some-other-client.apps.googleusercontent.test' }, 'authorized_party_mismatch'],
      [{ iss: 'https://accounts.example.invalid' }, 'issuer_mismatch'],
    ] as const) {
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
          ...claims,
        }),
      );
      const outcome = await handleCallback(fixture.deps, { state: stateOf(started.authorizationUrl), code });
      expect(outcome).toEqual({ authenticated: false, refusal });
    }
  });

  it('refuses a domain user who has no membership, however valid the token is', async () => {
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
        sub: fixture.alpha.outsider.googleSub,
        email: fixture.alpha.outsider.email,
        hd: fixture.hostedDomain,
        nonce: nonceOf(started.authorizationUrl),
      }),
    );
    const outcome = await handleCallback(fixture.deps, { state: stateOf(started.authorizationUrl), code });
    expect(outcome).toEqual({ authenticated: false, refusal: 'membership_required' });
  });
});

describe('Appendix G 24: a stolen device and a revoked membership', () => {
  it('revokes the device when an already-rotated refresh credential is presented again', async () => {
    const grant = await signIn(fixture.beta.salesperson, { workspaceId: fixture.beta.workspaceId });

    const renewed = await renewSession(fixture.deps, {
      refreshCredential: grant.refreshCredential,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    expect(renewed.renewed).toBe(true);

    // The thief presents the credential the legitimate Mac already spent.
    const reuse = await renewSession(fixture.deps, {
      refreshCredential: grant.refreshCredential,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    expect(reuse).toEqual({ renewed: false, refusal: 'credential_reuse' });

    // Reuse revokes the device, so the credential the rotation handed out is dead too,
    // and every session the device held is over.
    if (renewed.renewed) {
      const afterRevocation = await authenticate(fixture.deps, `Bearer ${renewed.grant.accessToken}`);
      expect(afterRevocation).toEqual({ authenticated: false, refusal: 'device_revoked' });
    }
    const { rows } = await fixture.db.query<{ status: string }>('SELECT status FROM devices WHERE id = $1', [
      grant.deviceId,
    ]);
    expect(rows[0]?.status).toBe('revoked');
  });

  it('refuses every command from a device an admin revoked, and the session with it', async () => {
    const grant = await signIn(fixture.alpha.salesperson);
    expect((await authenticate(fixture.deps, `Bearer ${grant.accessToken}`)).authenticated).toBe(true);

    await fixture.db.query(
      "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE workspace_id = $1 AND id = $2",
      [grant.workspaceId, grant.deviceId],
    );
    expect(await authenticate(fixture.deps, `Bearer ${grant.accessToken}`)).toEqual({
      authenticated: false,
      refusal: 'device_revoked',
    });
  });

  it('refuses a session whose membership was deactivated', async () => {
    const grant = await signIn(fixture.alpha.salesperson);
    await fixture.db.query(
      "UPDATE workspace_memberships SET status = 'inactive', deactivated_at = now() WHERE workspace_id = $1 AND user_id = $2",
      [grant.workspaceId, grant.userId],
    );
    expect(await authenticate(fixture.deps, `Bearer ${grant.accessToken}`)).toEqual({
      authenticated: false,
      refusal: 'membership_inactive',
    });
    await fixture.db.query(
      "UPDATE workspace_memberships SET status = 'active', deactivated_at = NULL WHERE workspace_id = $1 AND user_id = $2",
      [grant.workspaceId, grant.userId],
    );
  });

  it('expires the access session after about an hour and demands full sign-in after thirty days', async () => {
    const grant = await signIn(fixture.alpha.salesperson);
    fixture.advance(3_600_000 + 1000);
    expect(await authenticate(fixture.deps, `Bearer ${grant.accessToken}`)).toEqual({
      authenticated: false,
      refusal: 'session_expired',
    });

    const renewed = await renewSession(fixture.deps, {
      refreshCredential: grant.refreshCredential,
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    expect(renewed.renewed).toBe(true);

    fixture.advance(30 * 24 * 3_600_000);
    if (renewed.renewed) {
      const stale = await renewSession(fixture.deps, {
        refreshCredential: renewed.grant.refreshCredential,
        clientVersion: CURRENT_CLIENT_VERSION,
      });
      expect(stale).toEqual({ renewed: false, refusal: 'reauthentication_required' });
    }
  });
});

describe('Appendix G 40: a minimum-client-version increase blocks mutation', () => {
  it('refuses a command from an outdated client and names the upgrade', async () => {
    const grant = await signIn(fixture.alpha.salesperson);
    const authenticated = await authenticate(fixture.deps, `Bearer ${grant.accessToken}`);
    expect(authenticated.authenticated).toBe(true);
    if (!authenticated.authenticated) return;

    const outcome = await runCommand(
      fixture.deps,
      authenticated.principal,
      {
        commandId: fixture.collidingCommandId,
        kind: 'membership.role_changed',
        payload: { role: 'admin' },
        clientVersion: OUTDATED_CLIENT_VERSION,
      },
      async () => ({ status: 'accepted' as const, result: { changed: true } }),
    );
    expect(outcome).toMatchObject({ status: 'refused', reason: 'client_upgrade_required' });

    // The refusal consumed nothing: no receipt exists, so the command id is still free
    // once the Mac has upgraded. That is the preserved upgrade path.
    const { rows } = await fixture.db.query<{ count: string }>(
      'SELECT count(*) AS count FROM command_receipts WHERE workspace_id = $1 AND command_id = $2',
      [grant.workspaceId, fixture.collidingCommandId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('refuses to start a sign-in from an outdated client but still publishes the range', async () => {
    const started = await startSignIn(fixture.deps, {
      workspaceId: fixture.alpha.workspaceId,
      deviceLabel: fixture.collidingDeviceLabel,
      clientVersion: OUTDATED_CLIENT_VERSION,
    });
    expect(started).toMatchObject({
      started: false,
      refusal: 'client_upgrade_required',
      // The published range of the fixture's `1.4.x` ceiling (lane g78).
      supportedClientVersions: { minimum: '1.2.0', maximum: '1.4.999' },
    });
  });

  it('accepts the same command from a supported client and replays it once', async () => {
    const grant = await signIn(fixture.alpha.salesperson);
    const authenticated = await authenticate(fixture.deps, `Bearer ${grant.accessToken}`);
    if (!authenticated.authenticated) throw new Error('not authenticated');

    let executions = 0;
    const request = {
      commandId: fixture.collidingCommandId,
      kind: 'membership.role_changed',
      payload: { role: 'admin' },
      clientVersion: CURRENT_CLIENT_VERSION,
    };
    const work = async (): Promise<{ status: 'accepted'; result: { changed: number } }> => {
      executions += 1;
      return { status: 'accepted', result: { changed: executions } };
    };

    const first = await runCommand(fixture.deps, authenticated.principal, request, work);
    const second = await runCommand(fixture.deps, authenticated.principal, request, work);
    expect(first).toEqual({ status: 'accepted', result: { changed: 1 }, replayed: false });
    expect(second).toEqual({ status: 'accepted', result: { changed: 1 }, replayed: true });
    expect(executions).toBe(1);
  });
});
