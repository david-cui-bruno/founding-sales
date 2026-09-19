import { z } from 'zod';
import { accountPreparationRequestSchema, accountPreparationSchema, type AccountPreparation } from '../../../../src/shared/contracts/accountPreparationContract';
import { accountRecordSchema } from '../../../../src/shared/contracts/accountRecordContract';
import { ownerSourceConfigurationSchema, ownerSourceKey } from '../../../../src/shared/contracts/ownerCommandContract';
import { DynamoStore } from './dynamoStore';
import { authorityRecordSchema, executionAuthorityKey, executionAuthorityFields } from './executionRepository';
import { accountKey } from './workerAccountRepository';
import { DynamoThreadIntakeRepository, mailCursorKey } from './threadIntakeRepository';
import type { WorkerAuth } from './workerAuth';

export class AccountPreparationReadError extends Error {
  constructor(readonly statusCode: 400 | 401 | 403 | 409 | 503, readonly code: string) { super(code); }
}
const unavailable = () => new AccountPreparationReadError(503, 'worker_unavailable');
const conditionalFailure = z.object({ name: z.literal('TransactionCanceledException'),
  CancellationReasons: z.array(z.object({ Code: z.string().optional() })) });
/** Descriptive fixed-row read. The final transaction contains only conditions,
 * not commands, grants, intake/readiness operations or durable writes. */
export async function readAccountPreparation(auth: WorkerAuth, raw: unknown, authorization: string | undefined): Promise<AccountPreparation> {
  const parsed = accountPreparationRequestSchema.safeParse(raw);
  if (!parsed.success) throw new AccountPreparationReadError(400, 'worker_invalid_request');
  const request = parsed.data;
  try {
    const principal = await auth.authenticate(authorization, ['events:read']);
    if (principal.kind !== 'device' || request.workspaceId !== principal.workspaceId || request.workspaceId !== auth.options.workspaceId) {
      throw new AccountPreparationReadError(403, 'worker_scope_denied');
    }
    const options = { ...auth.options, dynamo: auth.fencedDynamo(principal) };
    const store = new DynamoStore(options);
    const aKey = accountKey(request.accountId), authKey = executionAuthorityKey(request.accountId), sourceKey = ownerSourceKey(request.accountId);
    const accountRow = await store.get<unknown>(aKey);
    const authorityRow = await store.get<unknown>(authKey);
    const sourceRow = await store.get<unknown>(sourceKey);
    if (!accountRow || !authorityRow) throw new AccountPreparationReadError(409, 'preparation_unavailable');
    const account = accountRecordSchema.parse(accountRow.data);
    if (account.account.id !== request.accountId || account.routes.some(route => route.accountId !== request.accountId)
      || account.history.some(history => history.account.id !== request.accountId || history.routes.some(route => route.accountId !== request.accountId))) throw unavailable();
    const authority = authorityRecordSchema.parse(authorityRow.data);
    if (authority.authority.accountId !== request.accountId) throw unavailable();
    const configuration = sourceRow ? ownerSourceConfigurationSchema.parse(sourceRow.data) : null;
    if (configuration?.pairingId !== undefined && configuration.pairingId !== principal.pairingId) throw new AccountPreparationReadError(403, 'worker_scope_denied');
    if (configuration && (configuration.workspaceId !== request.workspaceId || configuration.accountId !== request.accountId
      || configuration.research && configuration.research.workspaceId !== request.workspaceId)) throw unavailable();
    const checks = [store.check(aKey, accountRow.rev), store.check(authKey, authorityRow.rev, executionAuthorityFields(authority)),
      sourceRow ? store.check(sourceKey, sourceRow.rev) : store.absent(sourceKey)];
    let mailCursor: AccountPreparation['mailCursor'] = null;
    if (configuration?.mailboxSubject !== null && configuration?.mailboxSubject !== undefined) {
      const subject = configuration.mailboxSubject;
      const cursor = await new DynamoThreadIntakeRepository(options).cursorState(request.accountId, subject);
      const key = mailCursorKey(request.accountId, subject);
      checks.push(cursor ? store.check(key, cursor.rev) : store.absent(key));
      mailCursor = { mailboxSubject: subject, envelopeRevision: cursor?.rev ?? null, scope: cursor?.data.scope ?? null };
    }
    // Strong Gets alone are not a snapshot. Fence the SAME rows we return;
    // fencedDynamo adds current TOKEN/PAIRING conditions to this transaction.
    try { await store.transact(checks); }
    catch (error) {
      const cancellation = conditionalFailure.safeParse(error);
      if (cancellation.success && cancellation.data.CancellationReasons.some(reason => reason.Code === 'ConditionalCheckFailed')) {
        throw new AccountPreparationReadError(409, 'preparation_changed');
      }
      throw error;
    }
    return accountPreparationSchema.parse({ ...request, pairingId: principal.pairingId, checkedAt: store.now(),
      authority: authority.authority, executionVersion: authority.version, configuration, mailCursor });
  } catch (error) {
    if (error instanceof AccountPreparationReadError) throw error;
    if (error instanceof Error && error.message === 'worker_unauthorized') throw new AccountPreparationReadError(401, 'worker_unauthorized');
    if (error instanceof Error && error.message === 'worker_scope_denied') throw new AccountPreparationReadError(403, 'worker_scope_denied');
    throw unavailable();
  }
}
