import { createHash, createHmac } from 'node:crypto';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { coalesceMailSync } from './coalesce.ts';
import type { MailPublicConfig } from './config.ts';
import { resolveGmailOAuthConfig } from './config.ts';
import type { EnvelopeCipher } from './envelope.ts';
import type { GmailClient } from './gmailClient.ts';
import {
  insertOrReviveMailbox,
  markMailboxDisconnected,
  openMailboxHold,
  readMailbox,
  readMailboxForOwner,
} from './mailboxes.ts';
import { startRecovery } from './recover.ts';
import type { SecretProvider } from './secretProvider.ts';
import { deleteRefreshToken, readRefreshToken, storeRefreshToken } from './tokens.ts';
import { cancelWatch } from './watch.ts';
import {
  DEFAULT_BASELINE_DAYS,
  GMAIL_SCOPES,
  acceptMail,
  refuseMail,
  type MailResult,
  type MailboxRow,
} from './types.ts';

/**
 * The Gmail grant (specification 5.1, 12.1, 12.3, 10.3).
 *
 * "Gmail authorization is a separate OAuth grant with `gmail.readonly` and
 * `gmail.send`. Revoking Gmail holds affected automation but does not end FSS login."
 *
 * The flow mirrors G2's sign-in deliberately — authorization code, PKCE, a one-time
 * state consumed by a conditional UPDATE, and a verifier derived from the state
 * rather than stored — because the two are the same problem and a second shape would
 * be a second set of mistakes. What differs is what comes back and where it goes: a
 * refresh token, envelope-encrypted before it reaches PostgreSQL, and a mailbox that
 * begins in `baseline_pending` with a coverage hold on its owner (12.3: "A newly
 * connected mailbox completes a bounded baseline ... before automation begins").
 *
 * Three things this does *not* do. It does not ask for a scope beyond the two. It
 * does not hold the client secret anywhere but the stack frame of the exchange. And
 * it does not put anything about the grant in the page the browser lands on — the
 * connection is reported to the Mac by its own authenticated read, exactly as G2
 * decided for sign-in.
 */

/**
 * The state row for one Gmail authorization.
 *
 * `oidc_authorization_requests` belongs to sign-in and its columns mean sign-in
 * things, so the Gmail grant keeps its state in `command_receipts`-free territory of
 * its own: a short-lived row in `mailbox_grant_requests`… which does not exist,
 * because a fourth table for a value that lives for five minutes is not worth a
 * migration. Instead the state is a MAC over the workspace, the user and an expiry,
 * which the callback verifies without reading anything: there is nothing to consume,
 * so there is nothing to leak, and replay is bounded by the expiry and by Google's
 * own one-use authorization code. See `docs/decisions/g7-oauth-state.md`.
 */
export interface GrantStateClaims {
  readonly workspaceId: string;
  readonly userId: string;
  readonly expiresAtEpochSeconds: number;
}

const STATE_VERSION = 'g1';

function stateBody(claims: GrantStateClaims): string {
  return [STATE_VERSION, claims.workspaceId, claims.userId, String(claims.expiresAtEpochSeconds)].join('.');
}

export function signGrantState(key: Buffer, claims: GrantStateClaims): string {
  const body = stateBody(claims);
  const mac = createHmac('sha256', key).update(body, 'utf8').digest('base64url');
  return `${Buffer.from(body, 'utf8').toString('base64url')}.${mac}`;
}

export function verifyGrantState(key: Buffer, state: string, nowEpochSeconds: number): GrantStateClaims | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [encoded, mac] = parts;
  if (encoded === undefined || mac === undefined) return null;
  let body: string;
  try {
    body = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = createHmac('sha256', key).update(body, 'utf8').digest('base64url');
  // Constant-length comparison over two base64url digests of the same algorithm.
  if (expected.length !== mac.length) return null;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ mac.charCodeAt(index);
  }
  if (difference !== 0) return null;

  const fields = body.split('.');
  const [version, workspaceId, userId, expiry] = fields;
  if (fields.length !== 4 || version !== STATE_VERSION) return null;
  if (workspaceId === undefined || userId === undefined || expiry === undefined) return null;
  const expiresAtEpochSeconds = Number(expiry);
  if (!Number.isInteger(expiresAtEpochSeconds) || expiresAtEpochSeconds <= nowEpochSeconds) return null;
  return { workspaceId, userId, expiresAtEpochSeconds };
}

/** The PKCE verifier for one grant, derived from its state. Nothing is stored. */
export function grantCodeVerifier(key: Buffer, state: string): string {
  return createHmac('sha256', key).update(`pkce:${state}`, 'utf8').digest('base64url');
}

export function grantCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

export interface MailGrantDeps {
  readonly gmail: GmailClient;
  readonly config: MailPublicConfig;
  readonly secrets: SecretProvider;
  readonly cipher: EnvelopeCipher;
  /** The HMAC key the state and the PKCE verifier are derived from. */
  readonly stateSigningKey: Buffer;
  readonly now?: (() => Date) | undefined;
  readonly grantSeconds?: number | undefined;
}

export interface BeginGrantOutcome {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export const DEFAULT_GRANT_SECONDS = 600;

/**
 * Start the grant. Returns the URL the Mac opens in the system browser.
 *
 * The scopes are `GMAIL_SCOPES` and the call cannot widen them: they are not a
 * parameter. `access_type=offline` and `prompt=consent` are what make Google return a
 * refresh token; without them a re-consent returns an access token only and the
 * mailbox would connect and then be unable to sync tomorrow.
 */
export async function beginGmailGrant(
  context: RepositoryContext,
  deps: MailGrantDeps,
): Promise<MailResult<BeginGrantOutcome>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuseMail('invalid_input');

  const now = (deps.now ?? ((): Date => new Date()))();
  const expiresAtEpochSeconds = Math.floor(now.getTime() / 1000) + (deps.grantSeconds ?? DEFAULT_GRANT_SECONDS);
  const state = signGrantState(deps.stateSigningKey, {
    workspaceId: context.scope.workspaceId,
    userId: actor.userId,
    expiresAtEpochSeconds,
  });
  const oauth = await resolveGmailOAuthConfig(deps.config, deps.secrets);
  const url = deps.gmail.authorizationUrl(oauth, {
    state,
    codeChallenge: grantCodeChallenge(grantCodeVerifier(deps.stateSigningKey, state)),
    scopes: GMAIL_SCOPES,
  });
  return acceptMail({
    authorizationUrl: url,
    expiresAt: new Date(expiresAtEpochSeconds * 1000).toISOString(),
  });
}

export interface CompleteGrantOutcome {
  readonly mailboxId: string;
  readonly emailAddress: string;
  readonly baselineStarted: boolean;
}

/**
 * Finish the grant: exchange the code, store the envelope, create the mailbox, hold
 * the owner's automation until the baseline proves coverage.
 *
 * The order matters and is the conservative one. The mailbox row and the token are
 * written before the coverage hold is opened, but every one of them is in the same
 * transaction, so there is no instant at which a mailbox exists and is not held.
 *
 * A grant that comes back without a refresh token is refused rather than accepted
 * hopefully: Google omits it when the user has consented before and `prompt=consent`
 * was not honoured, and a mailbox with an access token and no refresh token works for
 * an hour and then stops in a way that looks like a revocation.
 */
export async function completeGmailGrant(
  context: RepositoryContext,
  deps: MailGrantDeps,
  input: { readonly state: string; readonly code: string },
): Promise<MailResult<CompleteGrantOutcome>> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const claims = verifyGrantState(deps.stateSigningKey, input.state, Math.floor(now.getTime() / 1000));
  if (claims === null) return refuseMail('authorization_request_unknown');
  if (claims.workspaceId !== context.scope.workspaceId) return refuseMail('authorization_request_unknown');
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || actor.userId !== claims.userId) return refuseMail('authorization_request_unknown');

  const oauth = await resolveGmailOAuthConfig(deps.config, deps.secrets);
  const exchanged = await deps.gmail.exchangeAuthorizationCode(oauth, {
    code: input.code,
    codeVerifier: grantCodeVerifier(deps.stateSigningKey, input.state),
  });
  if (!exchanged.ok) return refuseMail('grant_refused');
  const refreshToken = exchanged.grant.refreshToken;
  if (refreshToken === null) return refuseMail('grant_refused');

  // Every scope FSS asked for must have come back. A partial grant is a mailbox that
  // can read and not send, or send and not reconcile, and Appendix B needs both.
  const granted = new Set(exchanged.grant.grantedScopes);
  if (!GMAIL_SCOPES.every(scope => granted.has(scope))) return refuseMail('grant_refused');

  const profile = await deps.gmail.getProfile(exchanged.grant);
  const address = profile.emailAddress.trim().toLowerCase();
  const domain = address.split('@')[1] ?? '';
  if (domain !== deps.config.hostedDomain.trim().toLowerCase()) return refuseMail('grant_refused');

  // One mailbox per address per workspace, and this one may belong to somebody else.
  const { rows } = await context.db.query<{ owner_user_id: string }>(
    'SELECT owner_user_id FROM mailboxes WHERE workspace_id = $1 AND email_address = $2',
    [context.scope.workspaceId, address],
  );
  const currentOwner = rows[0]?.owner_user_id;
  if (currentOwner !== undefined && currentOwner !== actor.userId) return refuseMail('mailbox_address_taken');

  const baselineFromAt = new Date(
    now.getTime() - (deps.config.baselineDays || DEFAULT_BASELINE_DAYS) * 24 * 3600 * 1000,
  ).toISOString();
  const mailbox = await insertOrReviveMailbox(context, {
    ownerUserId: actor.userId,
    emailAddress: address,
    providerAccountId: address,
    baselineFromAt,
  });
  await storeRefreshToken(context, { mailboxId: mailbox.id, plaintext: refreshToken, cipher: deps.cipher });

  // 12.3 and 4.2: nothing automated for this owner may run until coverage is proved.
  await openMailboxHold(context, {
    mailboxId: mailbox.id,
    ownerUserId: mailbox.ownerUserId,
    reasonCode: 'coverage_incomplete',
  });
  await startRecovery(context, { mailbox, reason: 'baseline', fromAt: baselineFromAt, toAt: now.toISOString() });
  await coalesceMailSync(context.db, {
    workspaceId: context.scope.workspaceId,
    mailboxId: mailbox.id,
    historyId: profile.historyId,
  });

  await recordCrmAuditEvent(context, {
    action: 'mailbox.connected',
    subjectKind: 'mailbox',
    subjectId: mailbox.id,
    // The address is business data the owner and an admin may see (Appendix F). The
    // token is not here, not hashed here, and not anywhere but `mailbox_tokens`.
    detail: { emailAddress: address },
  });

  return acceptMail({ mailboxId: mailbox.id, emailAddress: address, baselineStarted: true });
}

export interface DisconnectOutcome {
  readonly mailboxId: string;
  readonly tokenDeleted: boolean;
}

/**
 * Disconnect, or handle a departure (5.1, 10.3, 12.6).
 *
 * "Revoking Gmail holds affected automation but does not end FSS login", and
 * "departure immediately revokes membership, devices, sessions, and OAuth grants and
 * deletes refresh-token material".
 *
 * So the order is: tell Google, stop the watch, delete the material, mark the row,
 * hold the owner. Telling Google first is deliberate — if the revocation call fails
 * the command still completes, because a token FSS has deleted is a token FSS cannot
 * use, and leaving the row behind to retry a best-effort call would leave the
 * material in the database for the length of the retry.
 */
export async function disconnectMailbox(
  context: RepositoryContext,
  deps: Pick<MailGrantDeps, 'gmail' | 'config' | 'secrets' | 'cipher'>,
  input: { readonly mailboxId: string; readonly reason: string },
): Promise<MailResult<DisconnectOutcome>> {
  const mailbox = await readMailbox(context, input.mailboxId);
  if (mailbox === null) return refuseMail('mailbox_unknown');

  const actor = context.scope.actor;
  const permitted = actor.kind === 'system' || actor.role === 'admin' || actor.userId === mailbox.ownerUserId;
  if (!permitted) return refuseMail('not_assigned');

  const refreshToken = await readRefreshToken(context, { mailboxId: mailbox.id, cipher: deps.cipher });
  if (refreshToken !== null) {
    const oauth = await resolveGmailOAuthConfig(deps.config, deps.secrets);
    try {
      const access = await deps.gmail.refreshAccessToken(oauth, refreshToken);
      if (access.ok) await deps.gmail.stopWatch(access.grant);
      await deps.gmail.revokeRefreshToken(oauth, refreshToken);
    } catch {
      // Best effort. A grant FSS cannot reach is a grant FSS will stop using in the
      // next statement, and the salesperson can revoke it in their Google account.
    }
  }

  await cancelWatch(context, { mailboxId: mailbox.id, reason: 'disconnected' });
  const deleted = (await deleteRefreshToken(context, mailbox.id)) > 0;
  await markMailboxDisconnected(context, {
    mailboxId: mailbox.id,
    status: 'disconnected',
    reason: input.reason,
  });
  await openMailboxHold(context, {
    mailboxId: mailbox.id,
    ownerUserId: mailbox.ownerUserId,
    reasonCode: 'mailbox_disconnected',
  });
  await recordCrmAuditEvent(context, {
    action: 'mailbox.disconnected',
    subjectKind: 'mailbox',
    subjectId: mailbox.id,
    detail: { reason: input.reason, tokenDeleted: deleted },
  });

  return acceptMail({ mailboxId: mailbox.id, tokenDeleted: deleted });
}

/** The mailbox one salesperson owns, for the connection status the Mac reads. */
export async function readOwnMailbox(
  context: RepositoryContext,
  userId: string,
): Promise<MailboxRow | null> {
  return await readMailboxForOwner(context, userId);
}
