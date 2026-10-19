import type { RepositoryContext } from '../db/workspaceScope.ts';
import { withTransaction } from '../db/queryable.ts';
import type { EnvelopeCiphertext } from './envelope.ts';
import { resolveGmailOAuthConfig } from './config.ts';
import type { MailGrantDeps } from './oauth.ts';
import { readRefreshTokenEnvelope } from './tokens.ts';
import { GMAIL_SCOPES } from './types.ts';

interface MailboxIdentity {
  readonly [column: string]: unknown;
  readonly id: string;
  readonly owner_user_id: string;
  readonly email_address: string;
  readonly provider_account_id: string | null;
  readonly generation: number;
  readonly status: string;
}

async function mailbox(context: RepositoryContext, id: string, lock = false) {
  return (await context.db.query<MailboxIdentity>(
    `SELECT id,owner_user_id,email_address,provider_account_id,generation,status FROM mailboxes
      WHERE workspace_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`,
    [context.scope.workspaceId, id],
  )).rows[0];
}

async function observed(context: RepositoryContext, row: MailboxIdentity) {
  return (await context.db.query(
    `SELECT 1 FROM mailbox_oauth_grant_observations
      WHERE workspace_id=$1 AND mailbox_id=$2 AND owner_user_id=$3
        AND provider_account_id=$4 AND generation=$5 AND granted_scopes @> $6::text[] LIMIT 1`,
    [context.scope.workspaceId, row.id, row.owner_user_id, row.provider_account_id, row.generation, GMAIL_SCOPES],
  )).rows.length !== 0;
}

function sameEnvelope(a: EnvelopeCiphertext, b: EnvelopeCiphertext) {
  return a.keyId === b.keyId && a.algorithm === b.algorithm &&
    a.wrappedDataKey.equals(b.wrappedDataKey) && a.ciphertext.equals(b.ciphertext) &&
    a.iv.equals(b.iv) && a.authTag.equals(b.authTag);
}

/**
 * Repair missing current provider evidence through ordinary authenticated owner status.
 * This is not consent, activation, a callback replay or a diagnostic authorization.
 * The caller supplies a real session recheck, run under final locks, never a user impersonation.
 * All KMS/Google waits precede the transaction. No token or message content is retained.
 */
export async function verifyExistingGmailGrant(
  context: RepositoryContext,
  deps: Pick<MailGrantDeps, 'gmail' | 'config' | 'secrets' | 'cipher' | 'acquisitionEnvironmentId'>,
  input: { readonly mailboxId: string; readonly authorizeObservation: () => Promise<boolean> },
): Promise<'observed' | 'already_observed' | 'unavailable'> {
  const actor = context.scope.actor;
  // Isolated acquisition diagnostics retain their separate metered consent path.
  if (actor.kind !== 'user' || deps.acquisitionEnvironmentId !== undefined) return 'unavailable';
  const before = await mailbox(context, input.mailboxId);
  if (!before || before.status !== 'connected' || before.owner_user_id !== actor.userId ||
      before.provider_account_id !== before.email_address) return 'unavailable';
  if (await observed(context, before)) return 'already_observed';
  const envelope = await readRefreshTokenEnvelope(context, before.id);
  if (!envelope) return 'unavailable';

  let scopes: string[];
  let address: string;
  try {
    const oauth = await resolveGmailOAuthConfig(deps.config, deps.secrets);
    const refreshed = await deps.gmail.refreshAccessToken(oauth, await deps.cipher.decrypt(envelope));
    if (!refreshed.ok) return 'unavailable';
    // Missing scope in a refresh response proves nothing. Never substitute requested scopes.
    scopes = [...new Set(refreshed.grant.grantedScopes ?? [])].sort();
    if (scopes.length > 30 || scopes.some(scope => !/^\S{1,200}$/u.test(scope)) ||
        !GMAIL_SCOPES.every(scope => scopes.includes(scope))) return 'unavailable';
    address = (await deps.gmail.getProfile(refreshed.grant)).emailAddress.trim().toLowerCase();
    if (address !== before.email_address || address !== before.provider_account_id ||
        address.split('@')[1] !== deps.config.hostedDomain.trim().toLowerCase()) return 'unavailable';
  } catch {
    // Provider/unwrap errors can contain secrets. Neither log nor surface their payloads.
    return 'unavailable';
  }

  return await withTransaction(context.db, async () => {
    if (!await input.authorizeObservation()) return 'unavailable';
    const member = (await context.db.query<{ role: string; status: string }>(
      `SELECT m.role,m.status FROM workspace_memberships m
        JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id
        WHERE m.workspace_id=$1 AND m.user_id=$2 FOR SHARE OF m,u,w`,
      [context.scope.workspaceId, actor.userId],
    )).rows[0];
    if (member?.status !== 'active' || member.role !== actor.role) return 'unavailable';
    const current = await mailbox(context, before.id, true);
    if (!current || current.status !== 'connected' || current.owner_user_id !== before.owner_user_id ||
        current.email_address !== address || current.provider_account_id !== before.provider_account_id ||
        current.generation !== before.generation) return 'unavailable';
    // Disconnect deletes the token before updating the mailbox. Never wait in the inverse order.
    await context.db.query('SELECT mailbox_id FROM mailbox_tokens WHERE workspace_id=$1 AND mailbox_id=$2 FOR SHARE NOWAIT',
      [context.scope.workspaceId, before.id]);
    const token = await readRefreshTokenEnvelope(context, before.id);
    if (!token || !sameEnvelope(envelope, token)) return 'unavailable';
    // Revocation locks remain held, but authentication time limits can expire during later lock waits.
    if (!await input.authorizeObservation()) return 'unavailable';
    // The mailbox lock serializes competing status repairs and normal reconnect callbacks.
    if (await observed(context, current)) return 'already_observed';
    await context.db.query(
      `INSERT INTO mailbox_oauth_grant_observations
        (workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes)
        VALUES($1,$2,$3,$4,$5,$6)`,
      [context.scope.workspaceId, current.id, actor.userId, current.provider_account_id, current.generation, scopes],
    );
    return 'observed';
  }).catch((error: unknown) => {
    // withTransaction has rolled back and released every lock before busy becomes a refusal.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03') return 'unavailable' as const;
    throw error;
  });
}
