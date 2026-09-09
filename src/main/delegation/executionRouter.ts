import type { AppDatabase } from '../db/database';
import { z } from 'zod';
import { accountIdSchema } from '../../shared/contracts/accountContract';
import type { AuthorityState, CommandReceipt } from '../../shared/contracts/delegationContract';
import type { DelegationRepository } from './delegationRepository';
const routeRequestSchema = z.strictObject({ accountId: accountIdSchema, commandId: z.uuid(), draftId: accountIdSchema,
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export type RouteSendRequest = Readonly<z.infer<typeof routeRequestSchema>>;
export type RouteSendResult = Readonly<{ status: 'held'; reason: 'authority_unavailable' | 'authority_inactive' | 'owner_unavailable' }> |
  Readonly<{ status: 'local_dispatched' }> | Readonly<{ status: 'worker_submitted'; receipt: CommandReceipt }>;
/** Main-only composition. Request carries exact references, never permission flags.
 * Local execution MUST call assertCurrent in its final SQL reservation transaction. */
export function createExecutionRouter(input: {
  repository: DelegationRepository;
  local: { send(request: RouteSendRequest, assertCurrent: () => void): Promise<RouteSendResult> };
  worker: { sendApproved(request: RouteSendRequest, owner: AuthorityState): Promise<RouteSendResult> };
}) {
  const { repository, local, worker } = input;
  return { async routeSend(value: RouteSendRequest): Promise<RouteSendResult> {
    const request = Object.freeze(routeRequestSchema.parse(value));
    const owner = repository.authority(request.accountId);
    if (!owner) return { status: 'held', reason: 'authority_unavailable' };
    if (repository.hasPendingStop(request.accountId) || ['delegating', 'paused', 'revoked'].includes(owner.state)) return { status: 'held', reason: 'authority_inactive' };
    if (owner.owner === 'worker' && owner.state === 'active') {
      try { return await worker.sendApproved(request, Object.freeze({ ...owner })); }
      catch { return { status: 'held', reason: 'owner_unavailable' }; }
    }
    if (owner.owner !== 'local' || owner.state !== 'local') return { status: 'held', reason: 'authority_unavailable' };
    return local.send(request, () => {
      const current = repository.authority(request.accountId);
      if (!current || current.owner !== 'local' || current.state !== 'local' || current.generation !== owner.generation) throw new Error('Local authority changed');
    });
  } };
}

/** Final historical-email fence. Existing unassociated local drafts retain their
 * legacy behavior. Any account association requires explicit paired local rights. */
export function assertLocalEmailAuthority(database: AppDatabase, input: {
  personId: string; recipient: string; expectedWorkspaceId?: string;
}): void {
  const raw = database.raw;
  if (!raw.inTransaction) throw new Error('email_authority_transaction_required');
  const accounts = raw.prepare(`SELECT DISTINCT account_id FROM pm_account_links WHERE person_id=?
    UNION SELECT DISTINCT account_id FROM pm_account_routes WHERE person_id=? OR (channel='email' AND lower(value)=lower(?))`)
    .all(input.personId, input.personId, input.recipient) as { account_id: string }[];
  for (const account of accounts) {
    const owner = raw.prepare('SELECT workspace_id,owner,state FROM delegated_authorities WHERE account_id=?').get(account.account_id) as
      { workspace_id: string; owner: string; state: string } | undefined;
    if (!input.expectedWorkspaceId || !owner || owner.workspace_id !== input.expectedWorkspaceId || owner.owner !== 'local' || owner.state !== 'local') {
      throw new Error('email_authority_unavailable');
    }
  }
}
