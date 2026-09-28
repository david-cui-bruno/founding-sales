import { withTransaction, type QueryResultRowLike } from '@fss/domain/db/queryable.ts';
import { clientCompatibility, publishedClientVersions, type AuthRefusalCode, type DeviceSession } from '@fss/contracts';
import type { AuthDeps } from './config.ts';
import { bearerOf, digestsEqual, formatAccessToken, parseAccessToken, sha256Hex } from './tokens.ts';

/**
 * Devices, sessions, and the one credential a Mac presents (specification 5.3,
 * Appendix G 24; wave 3b audit item S7, and lane W3-C2's removal of the rotation).
 *
 * "Sessions last about one hour and renew using a device-bound credential. ... Full
 * Google sign-in recurs every 30 days or after revocation."
 *
 * That credential is the device secret the Mac has held in its macOS Keychain since it
 * was claimed, and `openSession` is the only path that takes it. There was a second
 * one until migration 0021: a refresh credential that rotated on every use, where reuse
 * of a spent generation revoked the device. Nothing has renewed with it since desktop
 * 1.0.12, opening is strictly better — a credential lost to a restore or an overwrite
 * used to cost a full Google sign-in and no longer does — and 0021 drops the table it
 * lived in. So there is no rotation, no reuse to detect, and no second row to keep
 * consistent with the first.
 *
 * `openSession` still takes the `devices` row with `SELECT ... FOR UPDATE` as its first
 * statement, so two opens arriving together serialise over one row in one order.
 *
 * Two facts are the database's rather than this file's:
 *
 *   * every credential column is a sha256 digest, by a CHECK, so a plaintext token
 *     cannot be stored by mistake;
 *   * a session cannot be "ended" without an instant and a reason.
 */

export interface RegisteredDevice {
  readonly deviceId: string;
  /** Handed over once. It belongs in the macOS Keychain and nowhere else. */
  readonly deviceSecret: string;
}

export interface RegisterDeviceInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly deviceLabel: string;
  readonly clientVersion: string;
}

export async function registerDevice(deps: AuthDeps, input: RegisterDeviceInput): Promise<RegisteredDevice> {
  const deviceSecret = deps.randomSecret();
  const { rows } = await deps.db.query<{ id: string }>(
    `INSERT INTO devices (workspace_id, user_id, device_label, secret_hash, client_version, registered_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING id`,
    [
      input.workspaceId,
      input.userId,
      input.deviceLabel,
      sha256Hex(deviceSecret),
      input.clientVersion,
      deps.now().toISOString(),
    ],
  );
  const deviceId = rows[0]?.id;
  if (deviceId === undefined) throw new Error('device registration returned no row');
  return { deviceId, deviceSecret };
}

/** A session. There is no credential to hand back: the Mac's own does not rotate. */
export interface OpenedSession {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly reauthenticateAfter: string;
}

export interface IssueSessionInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly clientVersion: string;
  /** The 30-day boundary. Carried forward unchanged by every session this device opens. */
  readonly reauthenticateAfter: Date;
}

export async function issueSession(deps: AuthDeps, input: IssueSessionInput): Promise<OpenedSession> {
  const now = deps.now();
  const accessSecret = deps.randomSecret();
  const accessToken = formatAccessToken(input.workspaceId, accessSecret);

  // A session never outlives the 30-day boundary: near it, the hour is clipped rather
  // than allowed to carry authority past the point a full sign-in is due.
  const nominalExpiry = new Date(now.getTime() + deps.config.sessions.accessSessionSeconds * 1000);
  const expiresAt =
    nominalExpiry.getTime() > input.reauthenticateAfter.getTime() ? input.reauthenticateAfter : nominalExpiry;

  const inserted = await deps.db.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, user_id, device_id, access_token_hash, client_version, issued_at, expires_at, reauthenticate_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.workspaceId,
      input.userId,
      input.deviceId,
      sha256Hex(accessToken),
      input.clientVersion,
      now.toISOString(),
      expiresAt.toISOString(),
      input.reauthenticateAfter.toISOString(),
    ],
  );
  const sessionId = inserted.rows[0]?.id;
  if (sessionId === undefined) throw new Error('session insert returned no row');

  return {
    sessionId,
    accessToken,
    accessTokenExpiresAt: expiresAt.toISOString(),
    reauthenticateAfter: input.reauthenticateAfter.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface AuthenticatedPrincipal {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: 'admin' | 'salesperson';
  readonly membershipStatus: 'active' | 'inactive';
  readonly deviceId: string;
  readonly deviceStatus: 'active' | 'revoked';
  readonly sessionId: string;
}

export type AuthenticateOutcome =
  | { readonly authenticated: true; readonly principal: AuthenticatedPrincipal }
  | { readonly authenticated: false; readonly refusal: AuthRefusalCode };

interface SessionRow extends QueryResultRowLike {
  readonly id: string;
  readonly user_id: string;
  readonly device_id: string;
  readonly status: 'active' | 'ended';
  readonly expires_at: Date;
  readonly reauthenticate_after: Date;
  readonly device_status: 'active' | 'revoked';
  readonly membership_status: 'active' | 'inactive';
  readonly role: 'admin' | 'salesperson';
}

const SESSION_WITH_PRINCIPAL = `
  SELECT s.id, s.user_id, s.device_id, s.status, s.expires_at, s.reauthenticate_after,
         d.status AS device_status,
         m.status AS membership_status,
         m.role
    FROM sessions s
    JOIN devices d ON d.workspace_id = s.workspace_id AND d.id = s.device_id
    JOIN workspace_memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
   WHERE s.workspace_id = $1 AND s.access_token_hash = $2`;

/**
 * Who is calling, if anyone. Membership and device revocation are checked here, so
 * "checked on every command" (5.1) is a property of the one entry point rather than
 * of each route remembering.
 */
export async function authenticate(deps: AuthDeps, authorizationHeader: string | undefined): Promise<AuthenticateOutcome> {
  const bearer = bearerOf(authorizationHeader);
  if (bearer === null) return { authenticated: false, refusal: 'unauthenticated' };
  const parsed = parseAccessToken(bearer);
  if (parsed === null) return { authenticated: false, refusal: 'malformed_credential' };

  const { rows } = await deps.db.query<SessionRow>(SESSION_WITH_PRINCIPAL, [parsed.workspaceId, sha256Hex(bearer)]);
  const session = rows[0];
  if (session === undefined) return { authenticated: false, refusal: 'unauthenticated' };

  // Revocation beats expiry: a revoked device is told it is revoked, not that its
  // hour ran out, because the two call for different things from the person holding it.
  if (session.device_status !== 'active') return { authenticated: false, refusal: 'device_revoked' };
  if (session.membership_status !== 'active') return { authenticated: false, refusal: 'membership_inactive' };

  const now = deps.now();
  if (session.reauthenticate_after.getTime() <= now.getTime()) {
    return { authenticated: false, refusal: 'reauthentication_required' };
  }
  if (session.status !== 'active') return { authenticated: false, refusal: 'session_ended' };
  if (session.expires_at.getTime() <= now.getTime()) return { authenticated: false, refusal: 'session_expired' };

  return {
    authenticated: true,
    principal: {
      workspaceId: parsed.workspaceId,
      userId: session.user_id,
      role: session.role,
      membershipStatus: session.membership_status,
      deviceId: session.device_id,
      deviceStatus: session.device_status,
      sessionId: session.id,
    },
  };
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/**
 * Revoke a device and end everything it holds. Idempotent, and used by both the
 * sign-out path and the admin command, so the two can never diverge.
 */
export async function revokeDevice(
  deps: AuthDeps,
  input: {
    readonly workspaceId: string;
    readonly deviceId: string;
    readonly reason: 'signed_out' | 'device_revoked' | 'membership_revoked';
  },
): Promise<void> {
  const now = deps.now().toISOString();
  await deps.db.query(
    `UPDATE devices SET status = 'revoked', revoked_at = COALESCE(revoked_at, $3)
      WHERE workspace_id = $1 AND id = $2`,
    [input.workspaceId, input.deviceId, now],
  );
  await deps.db.query(
    `UPDATE sessions SET status = 'ended', ended_at = $3, end_reason = $4
      WHERE workspace_id = $1 AND device_id = $2 AND status = 'active'`,
    [input.workspaceId, input.deviceId, now, input.reason],
  );
}

/**
 * Has this device ever signed out? (wave 3b, review P1.)
 *
 * Asked of every session the device has held, not only its newest, and that is the
 * whole point. Under the pre-S7a server `endSession` ended the session and revoked the
 * rotating credential in two statements with no transaction around them, so a renewal that
 * slipped between them left a *newer* `active` session behind and the device still
 * `active` — a device that signed out whose newest session says nothing of the kind.
 * Equal `issued_at` values make "newest" indeterminate in the same way. Either way the
 * saved device secret of a Mac that signed out would open a session, which is the one
 * thing this change must never allow.
 *
 * It cannot touch a working Mac. Under the old server a sign-out was that
 * device's end — the next sign-in registers a new device — so a live device has no
 * `signed_out` session at all; under this one a sign-out revokes the device outright,
 * and a revoked device never reaches this question.
 */
async function signedOutBefore(deps: AuthDeps, workspaceId: string, deviceId: string): Promise<boolean> {
  const { rows } = await deps.db.query(
    `SELECT 1 FROM sessions
      WHERE workspace_id = $1 AND device_id = $2 AND end_reason = 'signed_out'
      LIMIT 1`,
    [workspaceId, deviceId],
  );
  return rows[0] !== undefined;
}

// ---------------------------------------------------------------------------
// Opening a session from the device secret (wave 3b, audit item S7)
// ---------------------------------------------------------------------------

export type OpenOutcome =
  | { readonly opened: true; readonly grant: DeviceSession }
  | { readonly opened: false; readonly refusal: AuthRefusalCode };

export interface OpenSessionInput {
  readonly workspaceId: string;
  readonly deviceId: string;
  /** The 256-bit secret minted at claim. Compared as a digest and never stored again. */
  readonly deviceSecret: string;
  readonly clientVersion: string;
}

interface DeviceRow extends QueryResultRowLike {
  readonly secret_hash: string;
  readonly status: 'active' | 'revoked';
  readonly user_id: string;
  readonly membership_status: 'active' | 'inactive';
  readonly role: 'admin' | 'salesperson';
}

/**
 * A session from the device secret this Mac has held since it was claimed: the only way
 * a Mac gets an access token short of a full Google sign-in.
 *
 * No rotation, so no reuse and no way to lose the credential by using it: opening twice
 * in a row works, and the earlier session is ended `renewed` like any other supersession.
 * There is deliberately no rate limit and no lockout — the secret is 256 random bits,
 * so guessing is not the threat, and a lockout keyed on a device id would let anyone
 * who knows one lock the owner out of their own Mac.
 *
 * The checks are in this order for a reason:
 *
 *   * the client version first, before any query, so an outdated Mac learns to upgrade
 *     without this API touching a row on its behalf;
 *   * an unknown device and a wrong secret get the same answer, `credential_unknown`,
 *     from a constant-time comparison. Which of the two it was is exactly what an
 *     attacker with a device id would like to be told;
 *   * revocation, then membership, as everywhere else in this file;
 *   * and then the device's newest session, which carries both the 30-day boundary and
 *     the reason the last session ended.
 */
export async function openSession(deps: AuthDeps, input: OpenSessionInput): Promise<OpenOutcome> {
  if (clientCompatibility(deps.config.supportedClientVersions, input.clientVersion).kind !== 'supported') {
    return { opened: false, refusal: 'client_upgrade_required' };
  }
  const now = deps.now();

  return await withTransaction(deps.db, async () => {
    // The device row first, and only the device row, so two opens arriving together
    // serialise over one row in one order.
    const { rows } = await deps.db.query<DeviceRow>(
      `SELECT d.secret_hash, d.status, d.user_id,
              m.status AS membership_status, m.role
         FROM devices d
         JOIN workspace_memberships m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id
        WHERE d.workspace_id = $1 AND d.id = $2
        FOR UPDATE OF d`,
      [input.workspaceId, input.deviceId],
    );
    const device = rows[0];
    if (device === undefined || !digestsEqual(sha256Hex(input.deviceSecret), device.secret_hash)) {
      return { opened: false, refusal: 'credential_unknown' };
    }
    if (device.status !== 'active') return { opened: false, refusal: 'device_revoked' };
    if (device.membership_status !== 'active') return { opened: false, refusal: 'membership_inactive' };

    // The boundary, from the newest session this device held.
    const newest = await deps.db.query<{ reauthenticate_after: Date }>(
      `SELECT reauthenticate_after FROM sessions
        WHERE workspace_id = $1 AND device_id = $2
        ORDER BY issued_at DESC LIMIT 1`,
      [input.workspaceId, input.deviceId],
    );
    const latest = newest.rows[0];
    // A registered device with no session at all is a row `claimSignIn` could not have
    // written. Nothing can be said about a boundary that does not exist, so: unknown.
    if (latest === undefined) return { opened: false, refusal: 'credential_unknown' };

    // A sign-out made before this release left the device `active`, because ending the
    // session was all a sign-out did then. The secret in that Mac's Keychain — or in a
    // backup of it — must not reopen the session the person ended, so the row is made
    // truthful now and the answer is the one a revoked device gets. The question is
    // asked of every session the device has held rather than of `latest`: see
    // `signedOutBefore` for the two states in which the newest one says nothing.
    if (await signedOutBefore(deps, input.workspaceId, input.deviceId)) {
      await revokeDevice(deps, {
        workspaceId: input.workspaceId,
        deviceId: input.deviceId,
        reason: 'signed_out',
      });
      return { opened: false, refusal: 'device_revoked' };
    }

    const reauthenticateAfter = latest.reauthenticate_after;
    if (reauthenticateAfter.getTime() <= now.getTime()) {
      return { opened: false, refusal: 'reauthentication_required' };
    }

    await deps.db.query(
      `UPDATE sessions SET status = 'ended', ended_at = $3, end_reason = 'renewed'
        WHERE workspace_id = $1 AND device_id = $2 AND status = 'active'`,
      [input.workspaceId, input.deviceId, now.toISOString()],
    );
    await deps.db.query(
      `UPDATE devices SET last_seen_at = $3, client_version = $4
        WHERE workspace_id = $1 AND id = $2`,
      [input.workspaceId, input.deviceId, now.toISOString(), input.clientVersion],
    );

    const session = await issueSession(deps, {
      workspaceId: input.workspaceId,
      userId: device.user_id,
      deviceId: input.deviceId,
      clientVersion: input.clientVersion,
      reauthenticateAfter,
    });

    return {
      opened: true,
      grant: {
        workspaceId: input.workspaceId,
        userId: device.user_id,
        role: device.role,
        deviceId: input.deviceId,
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
        reauthenticateAfter: session.reauthenticateAfter,
        supportedClientVersions: publishedClientVersions(deps.config.supportedClientVersions),
      },
    };
  });
}

/**
 * Sign out: revoke the device (wave 3b).
 *
 * It used to end the session and spend the rotating credential and leave the `devices`
 * row `active`, which was true of a Mac that had given up a credential it could not get
 * back. It is not true of a Mac that holds a device secret: the secret is still in its
 * Keychain until the app deletes it, it is still in every Time Machine backup, and
 * "the person signed out" has to mean the secret is dead at the server too. So the row
 * says what happened — `revoked`, with `signed_out` on every session it held — and the
 * next sign-in registers a new device exactly as it always did.
 */
export async function endSession(deps: AuthDeps, principal: AuthenticatedPrincipal): Promise<void> {
  await revokeDevice(deps, {
    workspaceId: principal.workspaceId,
    deviceId: principal.deviceId,
    reason: 'signed_out',
  });
}
