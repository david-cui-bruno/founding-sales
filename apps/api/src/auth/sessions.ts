import { withTransaction, type QueryResultRowLike } from '@fss/domain/db/queryable.ts';
import {
  clientCompatibility,
  publishedClientVersions,
  type AuthRefusalCode,
  type DeviceSession,
  type SessionRenewal,
} from '@fss/contracts';
import type { AuthDeps } from './config.ts';
import { recordAuditEvent } from './audit.ts';
import {
  bearerOf,
  digestsEqual,
  formatAccessToken,
  formatRefreshCredential,
  parseAccessToken,
  parseRefreshCredential,
  sha256Hex,
} from './tokens.ts';

/**
 * Devices, sessions, and the two credentials a Mac may present (specification 5.3,
 * Appendix G 24; wave 3b, audit item S7).
 *
 * "Sessions last about one hour and renew using a device-bound credential that
 * rotates on every use. Reuse revokes the device. ... Full Google sign-in recurs
 * every 30 days or after revocation."
 *
 * Two credentials, for one desktop release. `renewSession` is the rotating one, which
 * desktop 1.0.12 holds and which is unchanged on the wire. `openSession` is the
 * long-lived device secret the Mac has held in its Keychain since it was claimed and
 * which nothing ever asked for again: a renewal lost to a restore or an overwrite used
 * to cost a full Google sign-in, and it no longer does. Lane W3-C removes the rotating
 * one once the build that opens is confirmed installed.
 *
 * **Both take the device row first.** `SELECT ... FOR UPDATE` on `devices` is the first
 * statement of either transaction, so an open and a renewal that arrive together
 * serialise in one order and cannot deadlock over the credential rows.
 *
 * Three facts are the database's rather than this file's:
 *
 *   * a device has at most one live refresh credential, by a partial unique index, so
 *     a rotation that forgot to spend the old row cannot commit;
 *   * every credential column is a sha256 digest, by a CHECK, so a plaintext token
 *     cannot be stored by mistake;
 *   * a session cannot be "ended" without an instant and a reason.
 *
 * Reuse detection is therefore not a heuristic: the old generation's row is still
 * there, marked `rotated`, and presenting it is unambiguous.
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

/** A session opened from the device secret: there is no rotating credential to hand back. */
export interface OpenedSession {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly reauthenticateAfter: string;
}

export interface IssuedSession extends OpenedSession {
  readonly refreshCredential: string;
}

export interface IssueSessionInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly clientVersion: string;
  /** The 30-day boundary. Carried forward unchanged by every renewal. */
  readonly reauthenticateAfter: Date;
  /** The generation of the credential issued with this session. Defaults to 1. */
  readonly generation?: number;
  /**
   * Whether to mint the rotating refresh credential alongside the session. Default
   * true; `openSession` passes false, because the Mac's credential on that path is the
   * device secret it already holds. It is a skip rather than a second row: the partial
   * unique index admits one live credential per device, and a row nobody will ever
   * present is a thing to explain rather than a thing to have.
   */
  readonly withRefreshCredential?: boolean;
}

export async function issueSession(
  deps: AuthDeps,
  input: IssueSessionInput & { readonly withRefreshCredential?: true },
): Promise<IssuedSession>;
export async function issueSession(
  deps: AuthDeps,
  input: IssueSessionInput & { readonly withRefreshCredential: false },
): Promise<OpenedSession>;
export async function issueSession(deps: AuthDeps, input: IssueSessionInput): Promise<OpenedSession> {
  const now = deps.now();
  const generation = input.generation ?? 1;
  const withRefreshCredential = input.withRefreshCredential ?? true;
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

  const opened: OpenedSession = {
    sessionId,
    accessToken,
    accessTokenExpiresAt: expiresAt.toISOString(),
    reauthenticateAfter: input.reauthenticateAfter.toISOString(),
  };
  if (!withRefreshCredential) return opened;

  const refreshCredential = formatRefreshCredential(
    input.workspaceId,
    input.deviceId,
    generation,
    deps.randomSecret(),
  );

  // A refresh credential never outlives the boundary a full sign-in is due at: past
  // it the credential could not renew anything anyway, and a live-looking row that
  // cannot be used is a thing to explain rather than a thing to have.
  const nominalCredentialExpiry = new Date(now.getTime() + deps.config.sessions.refreshCredentialSeconds * 1000);
  const credentialExpiresAt =
    nominalCredentialExpiry.getTime() > input.reauthenticateAfter.getTime()
      ? input.reauthenticateAfter
      : nominalCredentialExpiry;

  await deps.db.query(
    `INSERT INTO device_refresh_credentials (workspace_id, device_id, generation, secret_hash, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.workspaceId,
      input.deviceId,
      generation,
      sha256Hex(refreshCredential),
      now.toISOString(),
      credentialExpiresAt.toISOString(),
    ],
  );

  const issued: IssuedSession = { ...opened, refreshCredential };
  return issued;
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
// Renewal
// ---------------------------------------------------------------------------

export type RenewOutcome =
  | { readonly renewed: true; readonly grant: SessionRenewal }
  | { readonly renewed: false; readonly refusal: AuthRefusalCode };

export interface RenewInput {
  readonly refreshCredential: string;
  readonly clientVersion: string;
}

interface CredentialRow extends QueryResultRowLike {
  readonly generation: string;
  readonly secret_hash: string;
  readonly state: 'active' | 'rotated' | 'revoked';
  readonly expires_at: Date;
  readonly device_status: 'active' | 'revoked';
  readonly user_id: string;
  readonly membership_status: 'active' | 'inactive';
  readonly role: 'admin' | 'salesperson';
}

/**
 * Revoke a device and end everything it holds. Idempotent, and used by both the
 * reuse path and the admin command, so the two can never diverge.
 */
export async function revokeDevice(
  deps: AuthDeps,
  input: {
    readonly workspaceId: string;
    readonly deviceId: string;
    readonly reason: 'signed_out' | 'device_revoked' | 'membership_revoked' | 'credential_reuse';
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
  await deps.db.query(
    `UPDATE device_refresh_credentials SET state = 'revoked'
      WHERE workspace_id = $1 AND device_id = $2 AND state = 'active'`,
    [input.workspaceId, input.deviceId],
  );
}

export async function renewSession(deps: AuthDeps, input: RenewInput): Promise<RenewOutcome> {
  if (clientCompatibility(deps.config.supportedClientVersions, input.clientVersion).kind !== 'supported') {
    return { renewed: false, refusal: 'client_upgrade_required' };
  }
  const parsed = parseRefreshCredential(input.refreshCredential);
  if (parsed === null) return { renewed: false, refusal: 'malformed_credential' };
  const now = deps.now();

  return await withTransaction(deps.db, async () => {
    // The device row first, before any credential row is read (wave 3b). `openSession`
    // takes the same lock as its own first statement, so the two paths a Mac may use
    // at the same moment queue in one order over one row instead of meeting in the
    // middle over `device_refresh_credentials`. The ids come from the parsed
    // credential and are not trusted for anything else; a device that does not exist
    // locks nothing and the SELECT below answers `credential_unknown` as before.
    await deps.db.query('SELECT 1 FROM devices WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      parsed.workspaceId,
      parsed.deviceId,
    ]);

    const { rows } = await deps.db.query<CredentialRow>(
      `SELECT c.generation, c.secret_hash, c.state, c.expires_at,
              d.status AS device_status, d.user_id,
              m.status AS membership_status, m.role
         FROM device_refresh_credentials c
         JOIN devices d ON d.workspace_id = c.workspace_id AND d.id = c.device_id
         JOIN workspace_memberships m ON m.workspace_id = c.workspace_id AND m.user_id = d.user_id
        WHERE c.workspace_id = $1 AND c.device_id = $2 AND c.generation = $3
        FOR UPDATE OF c`,
      [parsed.workspaceId, parsed.deviceId, parsed.generation],
    );
    const credential = rows[0];
    if (credential === undefined) return { renewed: false, refusal: 'credential_unknown' };
    // The generation in the credential names the row; the secret still has to match it,
    // so a guessed generation is not a way in.
    if (credential.secret_hash !== sha256Hex(input.refreshCredential)) {
      return { renewed: false, refusal: 'credential_unknown' };
    }

    if (credential.state === 'rotated') {
      // Reuse — but only while this device is still on the rotating path, which is what
      // a live generation means. Once the device has moved to the device secret (an
      // open revokes whatever generation was live) or has signed out, there is no chain
      // left to be ahead of: the old generations are history, not evidence, and a
      // credential restored from a backup answers `credential_unknown` rather than
      // revoking a Mac that is working perfectly well on its token. The `rotated` rows
      // are left exactly as they are — `use_consistent` forbids moving them anywhere
      // else — they simply stop proving anything.
      const live = await deps.db.query(
        `SELECT 1 FROM device_refresh_credentials
          WHERE workspace_id = $1 AND device_id = $2 AND state = 'active'
          LIMIT 1`,
        [parsed.workspaceId, parsed.deviceId],
      );
      if (live.rows[0] === undefined) return { renewed: false, refusal: 'credential_unknown' };

      // Whoever holds the spent generation, the device is compromised: revoke it, end
      // its sessions, and require a full Google sign-in (5.3, Appendix G 24).
      //
      // Only `rotated` is reuse. A `revoked` credential was taken away deliberately —
      // by an admin, a sign-out or a membership ending — and calling that an attack
      // would make every ordinary sign-out look like one.
      await revokeDevice(deps, {
        workspaceId: parsed.workspaceId,
        deviceId: parsed.deviceId,
        reason: 'credential_reuse',
      });
      await recordAuditEvent(deps.db, {
        workspaceId: parsed.workspaceId,
        actor: { userId: credential.user_id, role: credential.role, kind: 'user' },
        action: 'auth.device_revoked',
        subjectKind: 'device',
        subjectId: parsed.deviceId,
        detail: { refusal: 'credential_reuse', generation: parsed.generation },
      });
      return { renewed: false, refusal: 'credential_reuse' };
    }

    if (credential.device_status !== 'active') return { renewed: false, refusal: 'device_revoked' };
    if (credential.membership_status !== 'active') return { renewed: false, refusal: 'membership_inactive' };
    // Revoked while the device itself is still registered: a sign-out. The Mac signs
    // in with Google again rather than renewing a credential it gave up.
    if (credential.state !== 'active') return { renewed: false, refusal: 'credential_unknown' };

    // The 30-day boundary lives on the sessions this device has held. The newest one
    // carries it, whether or not it is still active. It is checked before the
    // credential's own expiry because the two fall together — the credential is
    // clipped to the boundary — and "sign in with Google again" is the useful answer.
    const boundary = await deps.db.query<{ reauthenticate_after: Date }>(
      `SELECT reauthenticate_after FROM sessions
        WHERE workspace_id = $1 AND device_id = $2
        ORDER BY issued_at DESC LIMIT 1`,
      [parsed.workspaceId, parsed.deviceId],
    );
    const reauthenticateAfter = boundary.rows[0]?.reauthenticate_after;
    if (reauthenticateAfter === undefined) return { renewed: false, refusal: 'credential_unknown' };
    if (reauthenticateAfter.getTime() <= now.getTime()) {
      return { renewed: false, refusal: 'reauthentication_required' };
    }
    if (credential.expires_at.getTime() <= now.getTime()) return { renewed: false, refusal: 'credential_expired' };

    // Rotate. The old generation is spent before the new one exists, which is what the
    // partial unique index on (workspace_id, device_id) WHERE state = 'active' demands.
    await deps.db.query(
      `UPDATE device_refresh_credentials SET state = 'rotated', used_at = $4
        WHERE workspace_id = $1 AND device_id = $2 AND generation = $3`,
      [parsed.workspaceId, parsed.deviceId, parsed.generation, now.toISOString()],
    );
    await deps.db.query(
      `UPDATE sessions SET status = 'ended', ended_at = $3, end_reason = 'renewed'
        WHERE workspace_id = $1 AND device_id = $2 AND status = 'active'`,
      [parsed.workspaceId, parsed.deviceId, now.toISOString()],
    );
    const nextGeneration = parsed.generation + 1;
    await deps.db.query(
      `UPDATE devices SET credential_generation = $3, last_seen_at = $4, client_version = $5
        WHERE workspace_id = $1 AND id = $2`,
      [parsed.workspaceId, parsed.deviceId, nextGeneration, now.toISOString(), input.clientVersion],
    );

    const session = await issueSession(deps, {
      workspaceId: parsed.workspaceId,
      userId: credential.user_id,
      deviceId: parsed.deviceId,
      clientVersion: input.clientVersion,
      reauthenticateAfter,
      generation: nextGeneration,
    });

    return {
      renewed: true,
      grant: {
        workspaceId: parsed.workspaceId,
        userId: credential.user_id,
        role: credential.role,
        deviceId: parsed.deviceId,
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
        refreshCredential: session.refreshCredential,
        reauthenticateAfter: session.reauthenticateAfter,
        supportedClientVersions: publishedClientVersions(deps.config.supportedClientVersions),
      },
    };
  });
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
 * A session from the device secret this Mac has held since it was claimed.
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
    // The device row first, and only the device row: `renewSession` takes the same lock
    // as its own first statement, so an open and a renewal arriving together serialise
    // over one row in one order rather than deadlocking over two.
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

    const newest = await deps.db.query<{ reauthenticate_after: Date; end_reason: string | null }>(
      `SELECT reauthenticate_after, end_reason FROM sessions
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
    // truthful now and the answer is the one a revoked device gets.
    if (latest.end_reason === 'signed_out') {
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
    // This Mac has moved to the device secret. Whatever generation was still live is
    // taken away rather than left to be presented later; the spent `rotated` rows are
    // untouched, because `use_consistent` forbids moving them and because they are
    // already no longer evidence of anything (`renewSession`).
    await deps.db.query(
      `UPDATE device_refresh_credentials SET state = 'revoked'
        WHERE workspace_id = $1 AND device_id = $2 AND state = 'active'`,
      [input.workspaceId, input.deviceId],
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
      withRefreshCredential: false,
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
 * It used to end the session and spend the credential and leave the `devices` row
 * `active`, which was true of a Mac that had given up a credential it could not get
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
