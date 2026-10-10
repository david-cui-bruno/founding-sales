import { accessForMailbox } from '@fss/domain/mail/sync.ts';
import { createGmailMailCaptureProvider } from '@fss/domain/mail/crmGmailProvider.ts';
import { createHistoricalGmailMailCaptureProvider } from '@fss/domain/mail/crmBackfillCapture.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { CrmMailBackfillDeps } from '../handlers/crmMailBackfill.ts';
import type { HandlerComposition } from './main.ts';

type AccessDeps = Parameters<typeof accessForMailbox>[1];
/** Server OAuth only: token exchange contains no unmetered Gmail data reads.
 * Immutable acquisition proof is verified separately by the capture/backfill worker.
 */
export function createServerCrmGmailAccessResolver(options: AccessDeps & { openSession(): Promise<{ session: SessionQueryable; close(): Promise<void> }> }): CrmMailBackfillDeps['resolveAccess'] {
  return async input => {
    const opened = await options.openSession();
    try {
    const context = repositoryContext(workspaceScope(input.workspaceId, { kind: 'system', component: 'worker' }), opened.session);
    async function current() {
      const row = (await context.db.query<{ owner_user_id: string; provider_account_id: string; generation: number; status: string; member_status: string }>(`SELECT m.owner_user_id,m.provider_account_id,m.generation,m.status,w.status AS member_status FROM mailboxes m JOIN workspace_memberships w ON w.workspace_id=m.workspace_id AND w.user_id=m.owner_user_id WHERE m.workspace_id=$1 AND m.id=$2`, [input.workspaceId, input.mailboxId])).rows[0];
      return row !== undefined && row.status === 'connected' && row.member_status === 'active' && row.provider_account_id === input.providerAccountId && row.generation === input.generation ? row : null;
    }
    const before = await current();
    if (before === null) return null;
    const access = await accessForMailbox(context, options, input.mailboxId);
    if (!access.ok || access.access.expiresAtEpochSeconds <= (options.now?.() ?? new Date()).getTime() / 1000) return null;
    const after = await current();
    if (after === null || after.owner_user_id !== before.owner_user_id) return null;
    return { mailboxId: input.mailboxId, providerAccountId: input.providerAccountId, generation: input.generation, access: access.access };
    } finally { await opened.close(); }
  };
}
/** The same explicitly authorized Gmail instance feeds live capture and metered history.
 * The resolver acquires one dedicated server session for each token exchange.
 * Defaults remain unavailable and this factory does not enable any database control.
 */
export function composeCrmGmail(deps: CrmMailBackfillDeps): Pick<HandlerComposition, 'crmMailCapture' | 'crmMailBackfill'> {
  return {
    crmMailBackfill: deps,
    crmMailCapture: {
      proofVerifier: deps.proofVerifier,
      provider: createGmailMailCaptureProvider(deps),
      historicalProvider: createHistoricalGmailMailCaptureProvider(deps),
    },
  };
}
