import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deviceListSchema, deviceSessionSchema, type SessionGrant } from '@fss/contracts';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { AuthDeps } from '../../src/auth/config.ts';
import { authenticate, openSession } from '../../src/auth/sessions.ts';
import { claimSignIn, handleCallback, startSignIn } from '../../src/auth/signIn.ts';
import { route } from '../../src/server.ts';
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
 * The device secret as this Mac's only credential (wave 3b audit item S7; the rotating
 * one went with migration 0021, lane W3-C2).
 *
 * The audit's sentence was "a lost renewal today forces a full sign-in": the rotating
 * credential was the only thing a Mac could present, so losing it — a restore, a second
 * window, a crash between the rotation and the write — cost a Google sign-in. Every
 * registered Mac has held a 256-bit device secret since it was claimed, and nothing
 * ever asked for it again. `POST /auth/session/open` asks for it, and is now the only
 * path there is.
 *
 * Two things this file is careful about, because they are the ways the change could go
 * wrong rather than merely not work:
 *
 *   * **a secret restored from a backup must not reopen a Mac that signed out.** It is
 *     answered `device_revoked`, and the `devices` row is made truthful at that moment;
 *   * **two opens arriving together** must serialise over the `devices` row rather than
 *     meet in the middle.
 *
 * No secret is written down anywhere here. Every one either comes out of a real
 * sign-in or is 32 random bytes generated when the assertion runs.
 */

let fixture: AuthFixture;
let baseline: Date;

beforeAll(async () => {
  fixture = await createAuthFixture();
  baseline = fixture.deps.now();
});

// Two of these move the clock a month past the boundary; resetting here rather than at
// the end means a failing assertion cannot leave the next test in the future.
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

/** What the Mac sends to `openSession`, from the grant it stored at claim. */
function openInput(grant: SessionGrant, clientVersion = CURRENT_CLIENT_VERSION): {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly deviceSecret: string;
  readonly clientVersion: string;
} {
  return {
    workspaceId: grant.workspaceId,
    deviceId: grant.deviceId,
    deviceSecret: grant.deviceSecret,
    clientVersion,
  };
}

/** 32 random bytes in the device secret's shape. Generated here, a credential for nothing. */
function notThisMacsSecret(): string {
  return randomBytes(32).toString('base64url');
}

const routeOptions = (): Parameters<typeof route>[2] => ({
  session: fixture.db,
  supportedClientVersions: fixture.deps.config.supportedClientVersions,
  sendingEnabled: false,
  auth: fixture.deps,
});

/**
 * A session that keeps the SQL it was asked, in order.
 *
 * The concurrency case needs more than "both finished": it needs each connection's
 * own statement order, so that "the device row first" is asserted rather than
 * inferred from the fact that nothing went wrong.
 */
function recording(session: SessionQueryable): { readonly db: SessionQueryable; readonly statements: string[] } {
  const statements: string[] = [];
  const db: SessionQueryable = {
    async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
      statements.push(text);
      return await session.query<Row>(text, values);
    },
  };
  return { db, statements };
}

/** The first `FOR UPDATE` on `devices` itself, or -1. */
function deviceLockAt(statements: readonly string[]): number {
  return statements.findIndex(text => /FOR UPDATE/u.test(text) && /\bdevices\b/u.test(text));
}

/**
 * The state the pre-S7a sign-out could leave behind (review P1).
 *
 * `endSession` used to end the session and revoke the rotating credential in two
 * statements with no transaction around them. A renewal between them left a *newer*
 * `active` session and the device still `active`, so the device's newest session says
 * `end_reason = null` and nothing about the sign-out at all. Built by hand here,
 * because the server being tested no longer has a way to produce it.
 */
async function legacySignOutRace(grant: SessionGrant): Promise<void> {
  await fixture.db.query(
    `UPDATE sessions SET status = 'ended', ended_at = now(), end_reason = 'signed_out'
      WHERE workspace_id = $1 AND device_id = $2 AND status = 'active'`,
    [grant.workspaceId, grant.deviceId],
  );
  await fixture.db.query(
    `INSERT INTO sessions (workspace_id, user_id, device_id, access_token_hash, client_version,
                           issued_at, expires_at, reauthenticate_after)
     VALUES ($1, $2, $3, encode(sha256(convert_to(random()::text, 'UTF8')), 'hex'), $4,
             now(), now() + interval '1 hour', $5)`,
    [grant.workspaceId, grant.userId, grant.deviceId, CURRENT_CLIENT_VERSION, grant.reauthenticateAfter],
  );
}

async function deviceStatusOf(deviceId: string): Promise<string | undefined> {
  const { rows } = await fixture.db.query<{ status: string }>('SELECT status FROM devices WHERE id = $1', [deviceId]);
  return rows[0]?.status;
}

async function sessionEndings(deviceId: string): Promise<{ status: string; end_reason: string | null }[]> {
  const { rows } = await fixture.db.query<{ status: string; end_reason: string | null }>(
    'SELECT status, end_reason FROM sessions WHERE device_id = $1 ORDER BY issued_at',
    [deviceId],
  );
  return rows;
}

describe('opening a session with the device secret', () => {
  it('issues a session and ends what the device held', async () => {
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'Opening Mac' });

    const opened = await openSession(fixture.deps, openInput(grant));
    expect(opened.opened).toBe(true);
    if (!opened.opened) return;

    // The schema is strict, so a `refreshCredential` that crept back in would fail here
    // rather than quietly teach the Mac to keep rotating.
    expect(() => deviceSessionSchema.parse(opened.grant)).not.toThrow();
    expect(Object.keys(opened.grant)).not.toContain('refreshCredential');
    expect(opened.grant).toMatchObject({
      workspaceId: grant.workspaceId,
      userId: grant.userId,
      role: grant.role,
      deviceId: grant.deviceId,
      reauthenticateAfter: grant.reauthenticateAfter,
    });

    // The token works and the claim's session is over.
    const authenticated = await authenticate(fixture.deps, `Bearer ${opened.grant.accessToken}`);
    expect(authenticated.authenticated).toBe(true);
    expect(await sessionEndings(grant.deviceId)).toEqual([
      { status: 'ended', end_reason: 'renewed' },
      { status: 'active', end_reason: null },
    ]);

    // Opening twice in a row works. Nothing rotated, so there is nothing to lose by
    // asking again — which is the whole point of the change.
    const again = await openSession(fixture.deps, openInput(grant));
    expect(again.opened).toBe(true);
    if (!again.opened) return;
    expect((await authenticate(fixture.deps, `Bearer ${again.grant.accessToken}`)).authenticated).toBe(true);
    expect(await authenticate(fixture.deps, `Bearer ${opened.grant.accessToken}`)).toEqual({
      authenticated: false,
      refusal: 'session_ended',
    });
    expect(await deviceStatusOf(grant.deviceId)).toBe('active');
  });

  it('gives an unknown device and a wrong secret the same answer, down to the body', async () => {
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'Guessing Mac' });

    const wrongSecret = await route('POST', '/auth/session/open', routeOptions(), {
      body: { ...openInput(grant), deviceSecret: notThisMacsSecret() },
    });
    const unknownDevice = await route('POST', '/auth/session/open', routeOptions(), {
      body: {
        workspaceId: grant.workspaceId,
        deviceId: randomUUID(),
        deviceSecret: notThisMacsSecret(),
        clientVersion: CURRENT_CLIENT_VERSION,
      },
    });
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body).toMatchObject({ error: 'credential_unknown' });
    expect(unknownDevice.status).toBe(wrongSecret.status);
    expect(unknownDevice.body).toEqual(wrongSecret.body);

    // A wrong guess costs the Mac nothing: no lockout, and the device is untouched.
    expect(await deviceStatusOf(grant.deviceId)).toBe('active');
    expect((await openSession(fixture.deps, openInput(grant))).opened).toBe(true);
  });

  it('refuses a revoked device, an inactive membership and a passed boundary, each by name', async () => {
    const revoked = await signIn(fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'Revoked Mac' });
    await fixture.db.query(
      "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE workspace_id = $1 AND id = $2",
      [revoked.workspaceId, revoked.deviceId],
    );
    expect(await openSession(fixture.deps, openInput(revoked))).toEqual({
      opened: false,
      refusal: 'device_revoked',
    });

    const inactive = await signIn(fixture.beta, fixture.beta.salesperson, { deviceLabel: 'Inactive Mac' });
    await fixture.db.query(
      "UPDATE workspace_memberships SET status = 'inactive', deactivated_at = now() WHERE workspace_id = $1 AND user_id = $2",
      [inactive.workspaceId, inactive.userId],
    );
    expect(await openSession(fixture.deps, openInput(inactive))).toEqual({
      opened: false,
      refusal: 'membership_inactive',
    });
    await fixture.db.query(
      "UPDATE workspace_memberships SET status = 'active', deactivated_at = NULL WHERE workspace_id = $1 AND user_id = $2",
      [inactive.workspaceId, inactive.userId],
    );

    const stale = await signIn(fixture.alpha, fixture.alpha.admin, { deviceLabel: 'Stale Mac' });
    fixture.advance(30 * 24 * 3_600_000 + 1000);
    expect(await openSession(fixture.deps, openInput(stale))).toEqual({
      opened: false,
      refusal: 'reauthentication_required',
    });
  });

  it('revokes a device that signed out before this release rather than reopening it', async () => {
    // Exactly what the old `endSession` left behind: the session ended `signed_out` and
    // the `devices` row still `active`. The secret is still in that Mac's Keychain, and
    // in every backup of it, and it must not bring the session back.
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'Legacy Mac' });
    await fixture.db.query(
      `UPDATE sessions SET status = 'ended', ended_at = now(), end_reason = 'signed_out'
        WHERE workspace_id = $1 AND device_id = $2 AND status = 'active'`,
      [grant.workspaceId, grant.deviceId],
    );
    expect(await deviceStatusOf(grant.deviceId)).toBe('active');

    expect(await openSession(fixture.deps, openInput(grant))).toEqual({
      opened: false,
      refusal: 'device_revoked',
    });
    expect(await deviceStatusOf(grant.deviceId)).toBe('revoked');
    // And it stays refused, now for the ordinary reason.
    expect(await openSession(fixture.deps, openInput(grant))).toEqual({
      opened: false,
      refusal: 'device_revoked',
    });
  });

  it('revokes a legacy sign-out whose newest session is a later active one', async () => {
    // The race the review found. The device is `active`, its newest session is `active`
    // with no end reason, and the only trace of the sign-out is an older row — so a
    // check that read `latest.end_reason` would open a session for a Mac that signed
    // out. The question is asked of every session the device has held.
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'Raced Mac' });
    await legacySignOutRace(grant);
    expect(await deviceStatusOf(grant.deviceId)).toBe('active');

    expect(await openSession(fixture.deps, openInput(grant))).toEqual({
      opened: false,
      refusal: 'device_revoked',
    });
    expect(await deviceStatusOf(grant.deviceId)).toBe('revoked');
    expect((await sessionEndings(grant.deviceId)).filter(row => row.status === 'active')).toEqual([]);
  });

  it('refuses an outdated client before it touches a row, and a malformed body with 400', async () => {
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'Outdated Mac' });

    const outdated = await route('POST', '/auth/session/open', routeOptions(), {
      body: { ...openInput(grant), clientVersion: OUTDATED_CLIENT_VERSION },
    });
    expect(outdated.status).toBe(426);
    expect(outdated.body).toMatchObject({
      error: 'client_upgrade_required',
      upgrade: { supported: { minimum: '1.2.0', maximum: '1.4.999' } },
    });

    // The body is strict, and a malformed one is a 400 with never a hint about which
    // field the caller got wrong.
    for (const body of [
      {},
      { ...openInput(grant), extra: true },
      { ...openInput(grant), deviceSecret: 'not-a-secret' },
      { ...openInput(grant), deviceId: 'not-a-uuid' },
    ]) {
      const result = await route('POST', '/auth/session/open', routeOptions(), { body });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'malformed_body', message: 'The request body could not be read as JSON.' });
    }
  });

  it('answers a sign-out with device_revoked', async () => {
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'Signing-out Mac' });
    const signedOut = await route('POST', '/auth/sign-out', routeOptions(), {
      headers: { authorization: `Bearer ${grant.accessToken}` },
    });
    expect(signedOut.status).toBe(200);
    expect(await deviceStatusOf(grant.deviceId)).toBe('revoked');

    // Revocation is said plainly rather than dressed as a missing credential.
    expect(await openSession(fixture.deps, openInput(grant))).toEqual({
      opened: false,
      refusal: 'device_revoked',
    });
  });
});

describe('two opens arriving together', () => {
  it('serialise on the device row, in one order, and neither deadlocks nor revokes', async () => {
    const grant = await signIn(fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'Busy Mac' });

    // Two more backends, so the two calls are genuinely concurrent transactions rather
    // than two awaits on one connection.
    const firstDb = recording(await fixture.database.appRuntimeSession());
    const secondDb = recording(await fixture.database.appRuntimeSession());
    const first: AuthDeps = { ...fixture.deps, db: firstDb.db };
    const second: AuthDeps = { ...fixture.deps, db: secondDb.db };

    const holder = (await fixture.db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    expect(holder).toBeTypeOf('number');

    // Hold the device row here. Either path's first statement is the lock, so both
    // queue, and the count below is two.
    await fixture.db.query('BEGIN');
    await fixture.db.query('SELECT 1 FROM devices WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      grant.workspaceId,
      grant.deviceId,
    ]);

    const opening = openSession(first, openInput(grant));
    const alsoOpening = openSession(second, openInput(grant));
    // `allSettled` so a throw cannot escape as an unhandled rejection while the lock is
    // still held; "neither threw" is itself the no-deadlock assertion.
    const settled = Promise.allSettled([opening, alsoOpening]);

    // Who is waiting, and behind whom. PostgreSQL queues the second waiter for a row
    // behind the first waiter's tuple lock rather than behind us, so the shape to look
    // for is a chain rooted at this transaction, not two backends naming us.
    let waiting: { readonly pid: number; readonly blockers: number[] }[] = [];
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const { rows } = await fixture.db.query<{ pid: number; blockers: number[] }>(
          `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND cardinality(pg_blocking_pids(pid)) > 0`,
        );
        waiting = rows;
        if (waiting.length >= 2) break;
        await sleep(25);
      }
    } finally {
      await fixture.db.query('COMMIT');
    }

    const [firstResult, secondResult] = await settled;
    // Both calls stopped, and both stopped in one queue rooted at the device row: one
    // of them waits on this transaction, and every waiter waits on us or on a waiter.
    expect(waiting).toHaveLength(2);
    const waitingPids = waiting.map(row => row.pid);
    expect(waiting.some(row => row.blockers.includes(holder ?? -1))).toBe(true);
    expect(
      waiting.every(row => row.blockers.some(pid => pid === holder || waitingPids.includes(pid))),
    ).toBe(true);

    // And the order each connection actually asked in: the device row is locked as the
    // first statement of either transaction. "Both eventually finished" would have
    // passed even if one had read another row first and queued afterwards.
    for (const [name, recorded] of [['first', firstDb], ['second', secondDb]] as const) {
      expect(deviceLockAt(recorded.statements), name).toBe(0);
    }
    expect([firstResult.status, secondResult.status]).toEqual(['fulfilled', 'fulfilled']);
    if (firstResult.status !== 'fulfilled' || secondResult.status !== 'fulfilled') return;

    // Whichever went first, both opens succeed: there is nothing to spend, so asking
    // twice is not a way to lose a credential.
    expect(firstResult.value.opened).toBe(true);
    expect(secondResult.value.opened).toBe(true);
    expect(await deviceStatusOf(grant.deviceId)).toBe('active');
    expect((await sessionEndings(grant.deviceId)).filter(row => row.status === 'active')).toHaveLength(1);
  });
});

describe('the device list and revocation', () => {
  it('lists this workspace’s Macs, newest first, and names the one that asked', async () => {
    const workspace = fixture.beta;
    const first = await signIn(workspace, workspace.admin, { deviceLabel: 'Desk Mac' });
    // A second later, so "newest first" is a fact about the rows rather than about the
    // order two inserts happened to land in.
    fixture.advance(1000);
    const second = await signIn(workspace, workspace.admin, { deviceLabel: 'Travel Mac' });
    const elsewhere = await signIn(fixture.alpha, fixture.alpha.admin, { deviceLabel: 'Alpha Mac' });

    const anonymous = await route('GET', '/devices', routeOptions());
    expect(anonymous.status).toBe(401);

    const listed = await route('GET', '/devices', routeOptions(), {
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect(listed.status).toBe(200);
    const devices = deviceListSchema.parse(listed.body);
    const mine = devices.filter(device => [first.deviceId, second.deviceId].includes(device.deviceId));
    expect(mine.map(device => device.deviceId)).toEqual([second.deviceId, first.deviceId]);
    expect(mine.map(device => device.thisDevice)).toEqual([true, false]);
    expect(mine[0]).toMatchObject({ deviceLabel: 'Travel Mac', status: 'active', clientVersion: CURRENT_CLIENT_VERSION });
    // Nothing from the other workspace, which shares this one's labels and users.
    expect(devices.map(device => device.deviceId)).not.toContain(elsewhere.deviceId);

    // `GET` only: a revocation must not be reachable by asking for the list.
    expect((await route('POST', '/devices', routeOptions(), {
      headers: { authorization: `Bearer ${second.accessToken}` },
      body: {},
    })).status).toBe(405);
  });

  it('revokes another Mac, audits it, and refuses an id this workspace does not own', async () => {
    const caller = await signIn(fixture.alpha, fixture.alpha.admin, { deviceLabel: 'Revoking Mac' });
    const target = await signIn(fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'Lost Mac' });
    const elsewhere = await signIn(fixture.beta, fixture.beta.salesperson, { deviceLabel: 'Beta Mac' });

    const revoked = await route('POST', '/devices/revoke', routeOptions(), {
      headers: { authorization: `Bearer ${caller.accessToken}` },
      body: { deviceId: target.deviceId },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ revoked: true, deviceId: target.deviceId, thisDevice: false });

    // The lost Mac can do neither of the two things a Mac can do.
    expect(await openSession(fixture.deps, openInput(target))).toEqual({
      opened: false,
      refusal: 'device_revoked',
    });
    expect(await authenticate(fixture.deps, `Bearer ${target.accessToken}`)).toEqual({
      authenticated: false,
      refusal: 'device_revoked',
    });
    // The caller's own Mac is untouched, and the event names who did it.
    expect((await authenticate(fixture.deps, `Bearer ${caller.accessToken}`)).authenticated).toBe(true);
    const { rows } = await fixture.db.query<{ actor_user_id: string; subject_id: string; detail: unknown }>(
      `SELECT actor_user_id, subject_id, detail FROM audit_events
        WHERE workspace_id = $1 AND action = 'auth.device_revoked' AND subject_id = $2`,
      [caller.workspaceId, target.deviceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: caller.userId,
      detail: { revokedDeviceId: target.deviceId },
    });

    // Another workspace's device, and an id that never existed, get one answer.
    for (const deviceId of [elsewhere.deviceId, randomUUID()]) {
      const refused = await route('POST', '/devices/revoke', routeOptions(), {
        headers: { authorization: `Bearer ${caller.accessToken}` },
        body: { deviceId },
      });
      expect(refused.status, deviceId).toBe(409);
      expect(refused.body).toEqual({ error: 'device_unknown', message: 'The request was refused.' });
    }
    expect(await deviceStatusOf(elsewhere.deviceId)).toBe('active');
  });

  it('lets a Mac revoke itself, which is a sign-out', async () => {
    const grant = await signIn(fixture.beta, fixture.beta.salesperson, { deviceLabel: 'Self Mac' });
    const revoked = await route('POST', '/devices/revoke', routeOptions(), {
      headers: { authorization: `Bearer ${grant.accessToken}` },
      body: { deviceId: grant.deviceId },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ revoked: true, deviceId: grant.deviceId, thisDevice: true });
    expect(await authenticate(fixture.deps, `Bearer ${grant.accessToken}`)).toEqual({
      authenticated: false,
      refusal: 'device_revoked',
    });
    expect(await openSession(fixture.deps, openInput(grant))).toEqual({
      opened: false,
      refusal: 'device_revoked',
    });
  });
});
