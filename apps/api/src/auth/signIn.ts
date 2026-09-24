import { withTransaction, type QueryResultRowLike } from '@fss/domain/db';
import {
  PROVISIONAL_GOOGLE_SUB_PREFIX,
  clientCompatibility,
  type AuthRefusalCode,
  type ClientVersionRange,
  type SessionGrant,
} from '@fss/contracts';
import type { AuthDeps } from './config.ts';
import { validateIdToken } from './idToken.ts';
import { issueSession, registerDevice } from './sessions.ts';
import { recordAuditEvent, SYSTEM_ACTOR } from './audit.ts';
import { codeChallengeOf, deriveCodeVerifier, sha256Hex } from './tokens.ts';

/**
 * Google sign-in through the system browser (specification 5.1, Appendix G 23).
 *
 * The flow has three moves and each one consumes something exactly once:
 *
 *   1. `startSignIn` mints a `state`, a `nonce` and a handoff secret, stores the
 *      digest of each, and hands back the authorization URL the Mac opens in the
 *      system browser.
 *   2. `handleCallback` runs on the API's own HTTPS callback. It consumes the state
 *      row with a conditional UPDATE — the row is the one-time-ness, so a replayed
 *      `state` finds nothing and never reaches Google — exchanges the code with the
 *      derived PKCE verifier, validates the id token, and records which user the
 *      browser proved.
 *   3. `claimSignIn` runs when the Mac presents the handoff secret it generated. It
 *      consumes the row a second and last time and mints every secret then, so no
 *      credential ever waits in the database between the browser and the app.
 *
 * Why not a loopback redirect or a custom scheme: docs/decisions/g2-redirect-target.md.
 */

export type StartSignInOutcome =
  | {
      readonly started: true;
      readonly authorizationUrl: string;
      readonly handoffSecret: string;
      readonly expiresAt: string;
    }
  | {
      readonly started: false;
      readonly refusal: AuthRefusalCode;
      readonly supportedClientVersions: ClientVersionRange;
    };

export interface StartSignInInput {
  readonly workspaceId: string;
  readonly deviceLabel: string;
  readonly clientVersion: string;
}

export async function startSignIn(deps: AuthDeps, input: StartSignInInput): Promise<StartSignInOutcome> {
  const { supportedClientVersions } = deps.config;

  // Starting a sign-in registers a device, which is a mutation, so an outdated client
  // is refused here as it is refused everywhere else (5.3, Appendix G 40). The
  // client-version notice stays readable, which is the upgrade path.
  if (clientCompatibility(supportedClientVersions, input.clientVersion).kind !== 'supported') {
    return { started: false, refusal: 'client_upgrade_required', supportedClientVersions };
  }

  const known = await deps.db.query<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [input.workspaceId]);
  if (known.rows[0] === undefined) {
    return { started: false, refusal: 'workspace_unknown', supportedClientVersions };
  }

  const state = deps.randomSecret();
  const nonce = deps.randomSecret();
  const handoffSecret = deps.randomSecret();
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + deps.config.sessions.authorizationRequestSeconds * 1000);

  await deps.db.query(
    `INSERT INTO oidc_authorization_requests
       (state_hash, workspace_id, nonce_hash, handoff_hash, code_challenge, device_label, client_version, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      sha256Hex(state),
      input.workspaceId,
      sha256Hex(nonce),
      sha256Hex(handoffSecret),
      codeChallengeOf(deriveCodeVerifier(deps.config.stateSigningKey, state)),
      input.deviceLabel,
      input.clientVersion,
      now.toISOString(),
      expiresAt.toISOString(),
    ],
  );

  // The fallback keeps the browser leg working when discovery answers null, and that is
  // exactly how the 24 September 2026 refusals stayed hidden: the browser went to Google,
  // the person signed in, and only the callback — which cannot fall back, because the
  // token endpoint is the thing discovery vouches for — failed. So the fallback says so.
  const discovery = await deps.google.discovery(deps.config.oidc);
  if (discovery === null) {
    deps.log?.log('warn', 'oidc_discovery_unavailable', {
      step: 'sign_in_start',
      fallback: 'authorization_endpoint',
    });
  }
  const authorizationEndpoint =
    discovery?.authorizationEndpoint ?? `${deps.config.oidc.issuer}/o/oauth2/v2/auth`;
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('client_id', deps.config.oidc.clientId);
  url.searchParams.set('redirect_uri', deps.config.oidc.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallengeOf(deriveCodeVerifier(deps.config.stateSigningKey, state)));
  url.searchParams.set('code_challenge_method', 'S256');
  // A hint only. `hd` is validated on the token, never trusted from the request.
  url.searchParams.set('hd', deps.config.oidc.hostedDomain);
  url.searchParams.set('prompt', 'select_account');

  return { started: true, authorizationUrl: url.toString(), handoffSecret, expiresAt: expiresAt.toISOString() };
}

export type CallbackOutcome =
  | { readonly authenticated: true; readonly workspaceId: string; readonly userId: string }
  | { readonly authenticated: false; readonly refusal: AuthRefusalCode };

interface ConsumedRequest extends QueryResultRowLike {
  readonly state_hash: string;
  readonly workspace_id: string;
  readonly nonce_hash: string;
  readonly device_label: string;
  readonly client_version: string;
}

export interface CallbackInput {
  readonly state: string;
  readonly code?: string;
  /** Google's own `error` parameter when the person refused consent. */
  readonly error?: string;
}

export async function handleCallback(deps: AuthDeps, input: CallbackInput): Promise<CallbackOutcome> {
  const now = deps.now();
  const stateHash = sha256Hex(input.state);

  // The one-time-ness of `state` is this UPDATE. `status = 'pending'` in the WHERE
  // clause means the second callback for one state changes no row, so a replay is
  // refused before a code is ever presented to Google.
  const consumed = await deps.db.query<ConsumedRequest>(
    `UPDATE oidc_authorization_requests
        SET status = 'failed', failure_code = 'callback_incomplete', resolved_at = $2
      WHERE state_hash = $1 AND status = 'pending' AND expires_at > $2
      RETURNING state_hash, workspace_id, nonce_hash, device_label, client_version`,
    [stateHash, now.toISOString()],
  );
  const request = consumed.rows[0];
  if (request === undefined) {
    // Either it never existed, or it was already used, or it expired. All three are
    // the same answer to the caller: there is nothing here.
    const expired = await deps.db.query<{ state_hash: string }>(
      'SELECT state_hash FROM oidc_authorization_requests WHERE state_hash = $1 AND expires_at <= $2',
      [stateHash, now.toISOString()],
    );
    return {
      authenticated: false,
      refusal: expired.rows[0] === undefined ? 'authorization_request_unknown' : 'authorization_request_expired',
    };
  }

  const fail = async (refusal: AuthRefusalCode): Promise<CallbackOutcome> => {
    await deps.db.query(
      "UPDATE oidc_authorization_requests SET status = 'failed', failure_code = $2 WHERE state_hash = $1",
      [stateHash, refusal],
    );
    await recordAuditEvent(deps.db, {
      workspaceId: request.workspace_id,
      actor: SYSTEM_ACTOR,
      action: 'auth.sign_in_refused',
      subjectKind: 'oidc_authorization_request',
      detail: { refusal },
    });
    return { authenticated: false, refusal };
  };

  if (input.error !== undefined || input.code === undefined || input.code.length === 0) {
    return await fail('provider_error');
  }

  const exchange = await deps.google.exchangeCode(deps.config.oidc, {
    code: input.code,
    codeVerifier: deriveCodeVerifier(deps.config.stateSigningKey, input.state),
  });
  if (!exchange.ok) {
    // One line, and only the closed reason and Google's own error code. The code, the
    // verifier, the client secret and the response body stay out of it: the refusal the
    // audit row records says *that* the exchange failed, and this says why, which is
    // what the four refusals of 24 September 2026 could not.
    deps.log?.log('warn', 'token_exchange_failed', {
      reason: exchange.reason,
      provider_error: exchange.providerError ?? undefined,
    });
    return await fail('token_exchange_failed');
  }

  const validated = await validateIdToken({
    token: exchange.idToken,
    config: deps.config.oidc,
    google: deps.google,
    now,
    expectedNonceHash: request.nonce_hash,
  });
  if (!validated.valid) return await fail(validated.refusal);

  // The provisional row an operator bootstrapped, adopted at its first sign-in (g39).
  //
  // `fss admin workspace bootstrap` writes the first admin's `users` row before that
  // person has ever presented an id token, with `google_sub` set to
  // `PROVISIONAL_GOOGLE_SUB_PREFIX` and the e-mail after it, because the real `sub` is
  // Google's to mint and is unknowable then. This is the one statement that turns such
  // a row into a real account, and it is safe for three reasons worth writing down:
  //
  //   1. the e-mail is not the caller's. It comes from an id token whose RS256
  //      signature, issuer, audience, nonce, `email_verified` and `hd` equal to the
  //      configured Workspace domain `validateIdToken` has already enforced
  //      (`apps/api/src/auth/idToken.ts`). Nothing an unauthenticated request says
  //      reaches `$2`;
  //   2. a provisional row exists only because somebody holding the runtime database
  //      credential wrote one. That principal could already write any row in any of
  //      these three tables, so adoption grants nothing that was not already granted
  //      by the act of bootstrapping;
  //   3. the sentinel cannot collide with a real identity. A Google `sub` is a decimal
  //      string of digits, so no token can ever carry `pending-email:<address>`, and
  //      the `NOT EXISTS` guard means an address that already has a real account is
  //      never clobbered — that account is found by the upsert below as it always was.
  //
  // Membership is unchanged by this: the check below still decides, and it is checked
  // again at the claim and on every command.
  //
  // `$4` is the prefix, bound rather than interpolated: a constant spliced into SQL
  // text is a habit that stops being safe the first time the value stops being one.
  const adopted = await deps.db.query(
    `UPDATE users
        SET google_sub = $1, display_name = $3, updated_at = now()
      WHERE google_sub = $4 || $2
        AND NOT EXISTS (SELECT 1 FROM users WHERE google_sub = $1)`,
    [
      validated.claims.subject,
      validated.claims.email.toLowerCase(),
      validated.claims.displayName,
      PROVISIONAL_GOOGLE_SUB_PREFIX,
    ],
  );

  // The `users` row is created on first successful sign-in: `sub` is the durable id,
  // and email is display data that may change. Existence still grants nothing — the
  // membership check below is what does, and it is checked again at claim and on
  // every command (5.1).
  const user = await deps.db.query<{ id: string }>(
    `INSERT INTO users (google_sub, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (google_sub)
     DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now()
     RETURNING id`,
    [validated.claims.subject, validated.claims.email, validated.claims.displayName],
  );
  const userId = user.rows[0]?.id;
  if (userId === undefined) return await fail('membership_required');

  if ((adopted.rowCount ?? 0) === 1) {
    await recordAuditEvent(deps.db, {
      workspaceId: request.workspace_id,
      actor: { userId, role: null, kind: 'user' },
      action: 'auth.provisional_user_adopted',
      subjectKind: 'user',
      subjectId: userId,
      detail: { adoptedFrom: 'bootstrap' },
    });
  }

  const membership = await deps.db.query<{ role: string }>(
    "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'",
    [request.workspace_id, userId],
  );
  if (membership.rows[0] === undefined) {
    await deps.db.query(
      "UPDATE oidc_authorization_requests SET status = 'failed', failure_code = 'membership_required' WHERE state_hash = $1",
      [stateHash],
    );
    await recordAuditEvent(deps.db, {
      workspaceId: request.workspace_id,
      actor: { userId, role: null, kind: 'user' },
      action: 'auth.sign_in_refused',
      subjectKind: 'user',
      subjectId: userId,
      detail: { refusal: 'membership_required' },
    });
    return { authenticated: false, refusal: 'membership_required' };
  }

  await deps.db.query(
    `UPDATE oidc_authorization_requests
        SET status = 'authenticated', failure_code = NULL, user_id = $2, resolved_at = $3
      WHERE state_hash = $1`,
    [stateHash, userId, now.toISOString()],
  );
  return { authenticated: true, workspaceId: request.workspace_id, userId };
}

export type ClaimOutcome =
  | { readonly claimed: true; readonly grant: SessionGrant }
  | { readonly claimed: false; readonly refusal: AuthRefusalCode };

export interface ClaimInput {
  readonly handoffSecret: string;
  readonly clientVersion: string;
}

interface ClaimedRequest extends QueryResultRowLike {
  readonly workspace_id: string;
  readonly user_id: string;
  readonly device_label: string;
}

export async function claimSignIn(deps: AuthDeps, input: ClaimInput): Promise<ClaimOutcome> {
  const { supportedClientVersions } = deps.config;
  if (clientCompatibility(supportedClientVersions, input.clientVersion).kind !== 'supported') {
    return { claimed: false, refusal: 'client_upgrade_required' };
  }

  const now = deps.now();
  const handoffHash = sha256Hex(input.handoffSecret);

  return await withTransaction(deps.db, async () => {
    const claimed = await deps.db.query<ClaimedRequest>(
      `UPDATE oidc_authorization_requests
          SET status = 'claimed', claimed_at = $2
        WHERE handoff_hash = $1 AND status = 'authenticated' AND expires_at > $2
        RETURNING workspace_id, user_id, device_label`,
      [handoffHash, now.toISOString()],
    );
    const request = claimed.rows[0];
    if (request === undefined) {
      const existing = await deps.db.query<{ status: string; expires_at: Date }>(
        'SELECT status, expires_at FROM oidc_authorization_requests WHERE handoff_hash = $1',
        [handoffHash],
      );
      const row = existing.rows[0];
      if (row === undefined) return { claimed: false, refusal: 'handoff_unknown' };
      if (row.status === 'claimed') return { claimed: false, refusal: 'already_claimed' };
      if (row.expires_at.getTime() <= now.getTime()) return { claimed: false, refusal: 'handoff_expired' };
      // Still pending: the browser has not come back yet, or it came back refused.
      return { claimed: false, refusal: 'handoff_unknown' };
    }

    // Membership is checked again here, not merely at the callback: a membership can
    // be revoked between the browser finishing and the Mac asking (5.1).
    const membership = await deps.db.query<{ role: 'admin' | 'salesperson' }>(
      "SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'",
      [request.workspace_id, request.user_id],
    );
    const role = membership.rows[0]?.role;
    if (role === undefined) return { claimed: false, refusal: 'membership_required' };

    const device = await registerDevice(deps, {
      workspaceId: request.workspace_id,
      userId: request.user_id,
      deviceLabel: request.device_label,
      clientVersion: input.clientVersion,
    });
    const session = await issueSession(deps, {
      workspaceId: request.workspace_id,
      userId: request.user_id,
      deviceId: device.deviceId,
      clientVersion: input.clientVersion,
      reauthenticateAfter: new Date(now.getTime() + deps.config.sessions.fullSignInSeconds * 1000),
    });

    await recordAuditEvent(deps.db, {
      workspaceId: request.workspace_id,
      actor: { userId: request.user_id, role, kind: role === 'admin' ? 'admin' : 'user' },
      action: 'auth.signed_in',
      subjectKind: 'device',
      subjectId: device.deviceId,
      detail: { clientVersion: input.clientVersion },
    });

    return {
      claimed: true,
      grant: {
        workspaceId: request.workspace_id,
        userId: request.user_id,
        role,
        deviceId: device.deviceId,
        deviceSecret: device.deviceSecret,
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
        refreshCredential: session.refreshCredential,
        reauthenticateAfter: session.reauthenticateAfter,
        supportedClientVersions,
      },
    };
  });
}
