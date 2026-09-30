import { createHash, createHmac, randomUUID } from 'node:crypto';
import { withTransaction } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { recordAccountSwitch } from './accounts.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { coalesceMailSync } from './coalesce.ts';
import type { MailPublicConfig } from './config.ts';
import { resolveGmailOAuthConfig } from './config.ts';
import type { EnvelopeCipher, EnvelopeCiphertext } from './envelope.ts';
import { GmailClientError, type GmailClient } from './gmailClient.ts';
import {
  insertOrReviveMailbox,
  markMailboxDisconnected,
  openMailboxHold,
  readMailbox,
  readMailboxForOwner,
  releaseMailboxHold,
  resetAccountState,
} from './mailboxes.ts';
import { startRecovery } from './recover.ts';
import type { SecretProvider } from './secretProvider.ts';
import { deleteRefreshToken, readRefreshToken, readRefreshTokenEnvelope, storeRefreshToken } from './tokens.ts';
import { cancelWatch } from './watch.ts';
import {
  DEFAULT_BASELINE_DAYS,
  GMAIL_SCOPES,
  acceptMail,
  refuseMail,
  type MailRefusalCode,
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
  /**
   * This grant attempt (call-to-booking A2). A refusal at the callback is audited with it
   * and reported by `/gmail/status`, so the Mac can tell "this attempt was refused" from
   * "an earlier one was". Null only for a state signed before the attempt id existed.
   */
  readonly attemptId?: string | null | undefined;
  /**
   * The owner's intent to replace their mailbox with this account (A2): the lowercased
   * address `POST /gmail/connect` named in `switchTo`. The callback switches the row to a
   * different Google account only when the state carries this and the chosen account is
   * this one. Null when the grant is a connect or a same-account re-consent.
   */
  readonly switchTo?: string | null | undefined;
}

/**
 * `g1` is the state before A2: workspace, user, expiry. `g2` adds the attempt id and the
 * switch intent. A `g1` state still verifies (one signed in the ten minutes before a
 * deploy) and carries neither — so it can never authorise a switch.
 */
const STATE_VERSION_G1 = 'g1';
const STATE_VERSION = 'g2';

function stateBody(claims: GrantStateClaims): string {
  return [
    STATE_VERSION,
    claims.workspaceId,
    claims.userId,
    String(claims.expiresAtEpochSeconds),
    claims.attemptId ?? '',
    // The address holds dots, which separate the fields, so it travels encoded.
    claims.switchTo === null || claims.switchTo === undefined
      ? ''
      : Buffer.from(claims.switchTo.trim().toLowerCase(), 'utf8').toString('base64url'),
  ].join('.');
}

export function signGrantState(key: Buffer, claims: GrantStateClaims): string {
  const body = stateBody(claims);
  const mac = createHmac('sha256', key).update(body, 'utf8').digest('base64url');
  return `${Buffer.from(body, 'utf8').toString('base64url')}.${mac}`;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The claims of a state whose MAC holds, and whether it has expired — or null when the
 * MAC does not hold or the body is not a state. The expired case is returned rather
 * than dropped so the callback can attribute an expired attempt to its user and audit
 * the refusal (A2); nothing may *act* on an expired state (`verifyGrantState`).
 */
export function readGrantState(
  key: Buffer,
  state: string,
  nowEpochSeconds: number,
): { readonly claims: GrantStateClaims; readonly expired: boolean } | null {
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
  const [version, workspaceId, userId, expiry, attempt, switchEncoded] = fields;
  if (workspaceId === undefined || userId === undefined || expiry === undefined) return null;
  let attemptId: string | null = null;
  let switchTo: string | null = null;
  if (version === STATE_VERSION_G1) {
    if (fields.length !== 4) return null;
  } else if (version === STATE_VERSION) {
    if (fields.length !== 6 || attempt === undefined || switchEncoded === undefined) return null;
    if (attempt !== '') {
      if (!UUID_SHAPE.test(attempt)) return null;
      attemptId = attempt;
    }
    if (switchEncoded !== '') switchTo = Buffer.from(switchEncoded, 'base64url').toString('utf8');
  } else {
    return null;
  }
  const expiresAtEpochSeconds = Number(expiry);
  if (!Number.isInteger(expiresAtEpochSeconds)) return null;
  return {
    // Absent rather than null when the state carries neither, so a `g1` state reads back
    // exactly as it was signed.
    claims: {
      workspaceId,
      userId,
      expiresAtEpochSeconds,
      ...(attemptId === null ? {} : { attemptId }),
      ...(switchTo === null ? {} : { switchTo }),
    },
    expired: expiresAtEpochSeconds <= nowEpochSeconds,
  };
}

export function verifyGrantState(key: Buffer, state: string, nowEpochSeconds: number): GrantStateClaims | null {
  const read = readGrantState(key, state, nowEpochSeconds);
  if (read === null || read.expired) return null;
  return read.claims;
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
  /**
   * How long a switch keeps retrying a mailbox row another transaction holds, in
   * milliseconds (`MAILBOX_ROW_LOCK_WINDOW_MILLISECONDS` unless a test shortens it).
   */
  readonly rowLockWindowMilliseconds?: number | undefined;
}

export interface BeginGrantOutcome {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  /** This attempt, as the signed state carries it (A2). */
  readonly attemptId: string;
}

export const DEFAULT_GRANT_SECONDS = 600;

/**
 * The fence states a switch waits for (migration 0010's `outbound_messages_state_known`
 * less its two terminal states, `sent` and `unknown_terminal`). A `held` fence is not
 * terminal: it returns to `prepared` when its hold clears, and it would then leave from
 * whichever account the row names at that instant.
 */
export const NON_TERMINAL_FENCE_STATES: readonly string[] = Object.freeze([
  'prepared',
  'held',
  'dispatching',
  'reconciling',
]);

async function pendingFenceCount(context: RepositoryContext, mailboxId: string): Promise<number> {
  const { rows } = await context.db.query<{ pending: string }>(
    `SELECT count(*) AS pending FROM outbound_messages
      WHERE workspace_id = $1 AND mailbox_id = $2 AND state = ANY ($3::text[])`,
    [context.scope.workspaceId, mailboxId, [...NON_TERMINAL_FENCE_STATES]],
  );
  return Number(rows[0]?.pending ?? 0);
}

const domainOf = (address: string): string => address.split('@')[1] ?? '';

/**
 * Start the grant. Returns the URL the Mac opens in the system browser.
 *
 * The scopes are `GMAIL_SCOPES` and the call cannot widen them: they are not a
 * parameter. `access_type=offline` and `prompt=consent` are what make Google return a
 * refresh token; without them a re-consent returns an access token only and the
 * mailbox would connect and then be unable to sync tomorrow.
 *
 * `switchTo` (call-to-booking A2) is the owner asking to replace their mailbox with
 * another account of the hosted domain. It is refused here, before anybody sees a
 * consent screen, when it names the mailbox's own address, another domain, or while
 * any fence of the mailbox is not terminal (the fence would otherwise leave from the new
 * account). Otherwise the lowercased address goes into the signed state as the intent
 * and into the consent URL as Google's `login_hint`. An owner with no mailbox has
 * nothing to switch: that is a plain connect, and the state carries no intent (the hint
 * is still passed, because the owner named the account).
 */
export async function beginGmailGrant(
  context: RepositoryContext,
  deps: MailGrantDeps,
  input: { readonly switchTo?: string | undefined } = {},
): Promise<MailResult<BeginGrantOutcome>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuseMail('invalid_input');

  const requested = input.switchTo?.trim().toLowerCase();
  let switchTo: string | null = null;
  if (requested !== undefined) {
    if (domainOf(requested) !== deps.config.hostedDomain.trim().toLowerCase()) {
      return refuseMail('mailbox_switch_wrong_domain');
    }
    const current = await readMailboxForOwner(context, actor.userId);
    if (current !== null) {
      if (current.emailAddress === requested) return refuseMail('mailbox_switch_same_address');
      if ((await pendingFenceCount(context, current.id)) > 0) return refuseMail('mailbox_switch_pending_sends');
      switchTo = requested;
    }
  }

  const now = (deps.now ?? ((): Date => new Date()))();
  const expiresAtEpochSeconds = Math.floor(now.getTime() / 1000) + (deps.grantSeconds ?? DEFAULT_GRANT_SECONDS);
  const attemptId = randomUUID();
  const state = signGrantState(deps.stateSigningKey, {
    workspaceId: context.scope.workspaceId,
    userId: actor.userId,
    expiresAtEpochSeconds,
    attemptId,
    switchTo,
  });
  const oauth = await resolveGmailOAuthConfig(deps.config, deps.secrets);
  const url = deps.gmail.authorizationUrl(oauth, {
    state,
    codeChallenge: grantCodeChallenge(grantCodeVerifier(deps.stateSigningKey, state)),
    scopes: GMAIL_SCOPES,
    // Google preselects the named account. A hint, never a check: the callback compares
    // the account Google actually returned with the intent in the state.
    ...(requested === undefined ? {} : { loginHint: requested }),
  });
  return acceptMail({
    authorizationUrl: url,
    expiresAt: new Date(expiresAtEpochSeconds * 1000).toISOString(),
    attemptId,
  });
}

export interface CompleteGrantOutcome {
  readonly mailboxId: string;
  readonly emailAddress: string;
  readonly baselineStarted: boolean;
  /** True when the row moved to a different Google account (A2). */
  readonly switched: boolean;
  /** For a switch: whether Gmail acknowledged `users.stop` on the old account's watch. */
  readonly oldWatchStopped: boolean | null;
}

/**
 * A refused grant, audited (A2): `mailbox.grant_refused { reason, attemptId }`, on the
 * user, and nothing else. `/gmail/status` reports the latest one after the user's latest
 * connect or switch as `lastGrantRefusal`, which is how the Mac learns what the browser
 * page deliberately does not say. Written on its own, outside any transaction the
 * refusal rolled back.
 */
export async function recordGrantRefusal(
  context: RepositoryContext,
  input: {
    readonly reason: MailRefusalCode;
    readonly attemptId: string | null;
    /** A short machine word for the operator, e.g. `mailbox_busy`. Never content. */
    readonly detail?: string | undefined;
  },
): Promise<void> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return;
  await recordCrmAuditEvent(context, {
    action: 'mailbox.grant_refused',
    subjectKind: 'user',
    subjectId: actor.userId,
    detail: {
      reason: input.reason,
      attemptId: input.attemptId,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
  });
}

/** Thrown inside the switch's transaction to roll it back with a refusal. */
class GrantRefusedInTransaction extends Error {
  constructor(readonly reason: MailRefusalCode) {
    super(reason);
  }
}

/**
 * Finish the grant: exchange the code, store the envelope, create the mailbox — or
 * revive it, or switch it to another account — and hold the owner's automation until
 * the baseline proves coverage.
 *
 * **Provider calls first, then one transaction.** The code exchange, the profile read
 * and, for a switch, a best-effort `users.stop` on the old account's watch (with the old
 * refresh token) all happen before any lock is taken, so no row lock is held across a
 * network call. Then everything the grant writes commits together or not at all, on the
 * request's session (`context.db` must be one connection — the route's and the test
 * world's both are), in this lock order: the exclusive send gate, the mailbox row, the
 * fence re-check. The gate comes first because a switch changes the address every later
 * send leaves from, which is a stop fact for a claim racing it (`policy/sendGate.ts`).
 *
 * **A different account needs intent.** A re-consent whose chosen account is not the
 * mailbox's own address is refused `mailbox_switch_not_requested` unless the state
 * carries `switchTo` — the silent switch this closes is the one where the browser was
 * signed into another account — and refused `mailbox_switch_address_mismatch` when it
 * carries an intent for a different account. Every refusal here is audited
 * (`recordGrantRefusal`) and changes nothing else: no row, token, watch or hold.
 *
 * **A switch keeps the mailbox id.** Messages, matches, permission evidence, fences and
 * the ramp keep referencing it. The account's history state is reset (cursor, watermark,
 * sync error), the current watch row is cancelled so the scheduler registers the new
 * account's watch on its next pass, and `mailbox_accounts` records the old account's
 * closed interval and the new one's open one. The generation advances, the baseline
 * restarts from the new account's profile `historyId`, and the coverage hold goes on.
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
  const read = readGrantState(deps.stateSigningKey, input.state, Math.floor(now.getTime() / 1000));
  if (read === null) return refuseMail('authorization_request_unknown');
  const claims = read.claims;
  if (claims.workspaceId !== context.scope.workspaceId) return refuseMail('authorization_request_unknown');
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || actor.userId !== claims.userId) return refuseMail('authorization_request_unknown');

  const attemptId = claims.attemptId ?? null;
  const refuse = async (reason: MailRefusalCode, detail?: string): Promise<MailResult<CompleteGrantOutcome>> => {
    await recordGrantRefusal(context, { reason, attemptId, ...(detail === undefined ? {} : { detail }) });
    return refuseMail(reason);
  };
  // An expired state is this user's, provably, and still refused: audited, so the Mac
  // can say the consent took too long.
  if (read.expired) return await refuse('authorization_request_unknown');

  const oauth = await resolveGmailOAuthConfig(deps.config, deps.secrets);
  const exchanged = await deps.gmail.exchangeAuthorizationCode(oauth, {
    code: input.code,
    codeVerifier: grantCodeVerifier(deps.stateSigningKey, input.state),
  });
  if (!exchanged.ok) return await refuse('grant_refused');
  const refreshToken = exchanged.grant.refreshToken;
  if (refreshToken === null) return await refuse('grant_refused');

  // Every scope FSS asked for must have come back. A partial grant is a mailbox that
  // can read and not send, or send and not reconcile, and Appendix B needs both.
  const granted = new Set(exchanged.grant.grantedScopes);
  if (!GMAIL_SCOPES.every(scope => granted.has(scope))) return await refuse('grant_refused');

  // The profile yields the address and the history id the baseline starts from, and it
  // is read before the interval's end is fixed (`toAt` below).
  const profile = await deps.gmail.getProfile(exchanged.grant);
  const address = profile.emailAddress.trim().toLowerCase();
  if (domainOf(address) !== deps.config.hostedDomain.trim().toLowerCase()) return await refuse('grant_refused');

  // One mailbox per address per workspace, and this one may belong to somebody else.
  const addressOwner = async (): Promise<string | undefined> => {
    const { rows } = await context.db.query<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM mailboxes WHERE workspace_id = $1 AND email_address = $2',
      [context.scope.workspaceId, address],
    );
    return rows[0]?.owner_user_id;
  };
  const taken = await addressOwner();
  if (taken !== undefined && taken !== actor.userId) return await refuse('mailbox_address_taken');

  // The intent, against the account Google returned.
  const intent = claims.switchTo ?? null;
  const before = await readMailboxForOwner(context, actor.userId);
  const decided = switchDecision(before, address, intent);
  if (!decided.ok) return await refuse(decided.reason);

  // The interval's end is read now, after the profile read, so it
  // is never earlier than the instant `profile.historyId` was captured: a message that
  // arrived before the capture is in the listing up to `toAt`, and one after it is in
  // history from `startHistoryId` (A1's continuous handoff).
  const toAt = (deps.now ?? ((): Date => new Date()))().toISOString();
  const baselineFromAt = new Date(
    Date.parse(toAt) - (deps.config.baselineDays || DEFAULT_BASELINE_DAYS) * 24 * 3600 * 1000,
  ).toISOString();

  try {
    const outcome = await withRowLockRetry(deps.rowLockWindowMilliseconds ?? MAILBOX_ROW_LOCK_WINDOW_MILLISECONDS, async remaining => await withTransaction(context.db, async () => {
      // 1. The exclusive send gate, before any row — waited for no longer than the retry
      // window has left (review C2B-A2-v2, N1). A gate held past it is `busy` too.
      await lockGateWithin(context, remaining);
      // 2. The mailbox row, and the decision again on what the lock shows: a concurrent
      // grant may have moved it since the read above. See `lockOwnMailbox` for the lock
      // strength and why it is taken the way it is.
      const locked = await lockOwnMailbox(context, actor.userId);
      // The switch's instant: the clock *now that the gate and the row are held*, never
      // `now()`, which is this transaction's start (review finding 3). A sync that
      // committed against the old account while this waited is before it, so its rows
      // stay the old account's; the new account's Sent items from that wait are too.
      // Rendered in UTC to the microsecond, and used as text everywhere — intervals and
      // audit alike — so no `Date` rounds it to the millisecond (review C2B-A2-v2, N2).
      const { rows: clock } = await context.db.query<{ at: string }>(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
      );
      const switchedAt = clock[0]?.at ?? '';
      const lockedOwner = await addressOwner();
      if (lockedOwner !== undefined && lockedOwner !== actor.userId) {
        throw new GrantRefusedInTransaction('mailbox_address_taken');
      }
      const again = switchDecision(locked, address, intent);
      if (!again.ok) throw new GrantRefusedInTransaction(again.reason);
      const switching = again.switching && locked !== null;
      // 3. The fences, under the lock: a fence prepared since `beginGmailGrant` checked.
      if (switching && (await pendingFenceCount(context, locked.id)) > 0) {
        throw new GrantRefusedInTransaction('mailbox_switch_pending_sends');
      }
      // 4. The old account's history state and its watch — and its token's envelope, read
      // here under the row lock so the post-commit stop is bound to the account this
      // transaction actually replaced (review C2B-A2-v2, N4). Not decrypted here: the
      // production cipher calls KMS, and no network call happens under the gate.
      const oldEnvelope = switching ? await readRefreshTokenEnvelope(context, locked.id) : null;
      const oldAddress = switching ? locked.emailAddress : null;
      if (switching) {
        await resetAccountState(context, { mailboxId: locked.id });
        await cancelWatch(context, { mailboxId: locked.id, reason: 'mailbox_switched' });
      }
      // 5. The revive: address, account id, generation + 1, baseline_pending.
      const mailbox = await insertOrReviveMailbox(context, {
        ownerUserId: actor.userId,
        emailAddress: address,
        providerAccountId: address,
        baselineFromAt,
      });
      // 6. The token.
      await storeRefreshToken(context, { mailboxId: mailbox.id, plaintext: refreshToken, cipher: deps.cipher });
      // 7. The account intervals.
      if (switching) {
        await recordAccountSwitch(context, {
          mailboxId: mailbox.id,
          fromAddress: locked.emailAddress,
          toAddress: address,
          toGeneration: mailbox.generation,
          at: switchedAt,
        });
      }
      // 8. 12.3 and 4.2: nothing automated for this owner may run until coverage is proved.
      await openMailboxHold(context, {
        mailboxId: mailbox.id,
        ownerUserId: mailbox.ownerUserId,
        reasonCode: 'coverage_incomplete',
      });
      // 9. The baseline, from the profile's history id.
      await startRecovery(context, {
        mailbox,
        reason: 'baseline',
        fromAt: baselineFromAt,
        toAt,
        startHistoryId: profile.historyId,
      });
      await coalesceMailSync(context.db, {
        workspaceId: context.scope.workspaceId,
        mailboxId: mailbox.id,
        generation: mailbox.generation,
        historyId: profile.historyId,
      });
      // 10. A reconnect ends the disconnection: nothing released this hold before A2.
      // `coverage_incomplete` stays until the baseline proves coverage.
      await releaseMailboxHold(context, { mailboxId: mailbox.id, reasonCode: 'mailbox_disconnected' });
      // 11. The audit row. The address is business data the owner and an admin may see
      // (Appendix F). The token is not here, not hashed here, and not anywhere but
      // `mailbox_tokens`.
      if (switching) {
        await recordCrmAuditEvent(context, {
          action: 'mailbox.switched',
          subjectKind: 'mailbox',
          subjectId: mailbox.id,
          detail: { from: locked.emailAddress, to: address, attemptId, switchedAt },
        });
      } else {
        await recordCrmAuditEvent(context, {
          action: 'mailbox.connected',
          subjectKind: 'mailbox',
          subjectId: mailbox.id,
          detail: { emailAddress: address, attemptId },
        });
      }
      return { mailbox, switching, oldEnvelope, oldAddress };
    }));
    // After the commit, and only for a switch: stop the old account's watch with its own
    // token, best effort. The answer is recorded, never acted on.
    let oldWatchStopped: boolean | null = null;
    if (outcome.switching) {
      const stop = await stopOldWatch(deps, oauth, outcome.oldEnvelope);
      oldWatchStopped = stop.stopped;
      await recordCrmAuditEvent(context, {
        action: 'mailbox.switch_old_watch',
        subjectKind: 'mailbox',
        subjectId: outcome.mailbox.id,
        detail: {
          attemptId,
          account: outcome.oldAddress,
          oldWatchStopped,
          ...(stop.failure === undefined ? {} : { failure: stop.failure }),
        },
      });
    }
    return acceptMail({
      mailboxId: outcome.mailbox.id,
      emailAddress: address,
      baselineStarted: true,
      switched: outcome.switching,
      oldWatchStopped: outcome.switching ? oldWatchStopped : null,
    });
  } catch (error) {
    if (error instanceof GrantRefusedInTransaction) return await refuse(error.reason);
    // The row stayed busy for the whole window: every attempt rolled back, so nothing
    // changed. Refused cleanly, and the owner can try again.
    if (error instanceof MailboxRowBusy) return await refuse('grant_refused', 'mailbox_busy');
    throw error;
  }
}

/**
 * What a grant for `address` does to the owner's current mailbox, given the state's
 * intent: connect or re-consent (no switch), switch, or a refusal.
 */
function switchDecision(
  current: MailboxRow | null,
  address: string,
  intent: string | null,
): { readonly ok: true; readonly switching: boolean } | { readonly ok: false; readonly reason: MailRefusalCode } {
  // An intent names one account, and only that one may complete it.
  if (intent !== null && intent !== address) return { ok: false, reason: 'mailbox_switch_address_mismatch' };
  // An intent to switch to the address the mailbox already is: a second attempt after
  // the first one completed. Refused, audited, and nothing changes (review finding 4).
  // A re-consent without intent is still accepted below.
  if (intent !== null && current !== null && current.emailAddress === address) {
    return { ok: false, reason: 'mailbox_switch_same_address' };
  }
  if (current === null || current.emailAddress === address) return { ok: true, switching: false };
  // Another account, and nobody asked for one: the silent switch.
  if (intent === null) return { ok: false, reason: 'mailbox_switch_not_requested' };
  return { ok: true, switching: true };
}

/**
 * `users.stop` on the old account's watch, with the old account's refresh token, after
 * the switch has committed. Best effort: stopped only when Gmail acknowledged the stop;
 * otherwise the failure is named (`no_token`, `refresh_<reason>`, `status_<code>`, or
 * the error's class) for the audit row, and never acted on.
 */
async function stopOldWatch(
  deps: MailGrantDeps,
  oauth: Awaited<ReturnType<typeof resolveGmailOAuthConfig>>,
  envelope: EnvelopeCiphertext | null,
): Promise<{ readonly stopped: boolean; readonly failure?: string }> {
  if (envelope === null) return { stopped: false, failure: 'no_token' };
  try {
    const refreshToken = await deps.cipher.decrypt(envelope);
    const access = await deps.gmail.refreshAccessToken(oauth, refreshToken);
    if (!access.ok) return { stopped: false, failure: `refresh_${access.reason}` };
    await deps.gmail.stopWatch(access.grant);
    return { stopped: true };
  } catch (error) {
    if (error instanceof GmailClientError && error.status !== undefined) {
      return { stopped: false, failure: `status_${String(error.status)}` };
    }
    return { stopped: false, failure: error instanceof Error ? error.name : 'error' };
  }
}

/**
 * Take the send gate, waiting at most `remainingMilliseconds` (floor 100 ms). A gate held
 * past that is `MailboxRowBusy`, like a busy row: the attempt rolls back, and the retry
 * either tries again or, with the window spent, refuses `grant_refused`/`mailbox_busy`.
 * The timeout is reset to its default once the gate is held, so nothing later in the
 * transaction inherits it.
 */
async function lockGateWithin(context: RepositoryContext, remainingMilliseconds: number): Promise<void> {
  const limit = Math.max(100, Math.floor(remainingMilliseconds));
  await context.db.query("SELECT set_config('lock_timeout', $1, true)", [`${String(limit)}ms`]);
  try {
    await lockSendGateForStopFact(context);
  } catch (error) {
    if ((error as { code?: unknown }).code === '55P03') throw new MailboxRowBusy();
    throw error;
  }
  await context.db.query('SET LOCAL lock_timeout TO DEFAULT');
}

/** The row lock was not available at once: roll back, release the gate, and retry. */
class MailboxRowBusy extends Error {
  constructor() {
    super('the mailbox row is locked by another transaction');
  }
}

/**
 * How long the switch retries a busy mailbox row: about 25 seconds, backing off from
 * 100 ms to 1 s. A `mail.sync` importing messages holds its `KEY SHARE` for the whole
 * job, Gmail reads included, so tens of seconds are ordinary; 25 s stays well inside the
 * load balancer's 60 s idle timeout on the browser's callback request.
 */
export const MAILBOX_ROW_LOCK_WINDOW_MILLISECONDS = 25_000;
const MAILBOX_ROW_LOCK_FIRST_PAUSE_MILLISECONDS = 100;
const MAILBOX_ROW_LOCK_LONGEST_PAUSE_MILLISECONDS = 1_000;

/**
 * The owner's mailbox row, locked `FOR UPDATE NOWAIT`, or null when there is none.
 *
 * Review of 5015abd8, finding 2. A mail import holds `KEY SHARE` on the row — the
 * foreign key of every message it inserts — and then takes the send gate for a direct
 * send's effects. This transaction holds the gate, and it changes `email_address`,
 * which is a column of a unique index (`mailboxes_one_per_address`), so its UPDATE needs
 * the row lock that conflicts with `KEY SHARE`. `FOR NO KEY UPDATE` alone does not avoid
 * the cycle: the revive's UPDATE then waits on the import's `KEY SHARE` while holding the
 * gate, and PostgreSQL aborts one of the two (40P01; `mailboxSwitch.test.ts` shows it).
 *
 * So the strong lock is taken up front, with `NOWAIT`, right after the gate. If an
 * import holds `KEY SHARE`, the lock is refused at once, the transaction rolls back —
 * releasing the gate the import is about to wait for — and the switch retries
 * (`withRowLockRetry`); a row still busy when the window closes is a clean refusal,
 * `grant_refused` with the detail `mailbox_busy`. Once the lock is held, the gate and the row are both this
 * transaction's: an importer can only wait on the row holding nothing this needs, and a
 * dispatch claim cannot hold the gate at all. The provider calls are all before the
 * transaction, so a retry repeats no Google call.
 */
async function lockOwnMailbox(context: RepositoryContext, ownerUserId: string): Promise<MailboxRow | null> {
  let rows: readonly { id: string }[];
  try {
    ({ rows } = await context.db.query<{ id: string }>(
      'SELECT id FROM mailboxes WHERE workspace_id = $1 AND owner_user_id = $2 FOR UPDATE NOWAIT',
      [context.scope.workspaceId, ownerUserId],
    ));
  } catch (error) {
    if ((error as { code?: unknown }).code === '55P03') throw new MailboxRowBusy();
    throw error;
  }
  const id = rows[0]?.id;
  return id === undefined ? null : await readMailbox(context, id);
}

async function withRowLockRetry<T>(windowMilliseconds: number, attempt: (remaining: number) => Promise<T>): Promise<T> {
  const deadline = Date.now() + windowMilliseconds;
  let pause = MAILBOX_ROW_LOCK_FIRST_PAUSE_MILLISECONDS;
  for (;;) {
    try {
      return await attempt(deadline - Date.now());
    } catch (error) {
      if (!(error instanceof MailboxRowBusy)) throw error;
      const left = deadline - Date.now();
      if (left <= 0) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(pause, left)));
      pause = Math.min(pause * 2, MAILBOX_ROW_LOCK_LONGEST_PAUSE_MILLISECONDS);
    }
  }
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

  // The exclusive send gate before any mailbox write (A1 fold 3): a disconnect is a stop
  // fact, and `markMailboxDisconnected` updates the row, which a dispatch claim holding
  // the gate shared may be about to key-share. Taken after the provider calls above, so
  // no Google call happens under it. The caller's transaction (the command's) holds it.
  await lockSendGateForStopFact(context);
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
