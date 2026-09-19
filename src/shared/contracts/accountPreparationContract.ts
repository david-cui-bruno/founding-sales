import { z } from 'zod';
import { accountIdSchema, accountInstantSchema } from './accountContract';
import { authorityStateSchema } from './delegationContract';
import { ownerSourceConfigurationSchema } from './ownerCommandContract';
import { mailAccountScopeSchema } from './mailThreadContract';

export const ACCOUNT_PREPARATION_MAX_REQUEST_BYTES = 1024;
export const ACCOUNT_PREPARATION_MAX_REPLY_BYTES = 512 * 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const getAccountPreparationSchema = z.strictObject({ accountId: accountIdSchema });
export const accountPreparationRequestSchema = z.strictObject({ workspaceId: accountIdSchema, accountId: accountIdSchema })
  .refine(value => bytes(value) <= ACCOUNT_PREPARATION_MAX_REQUEST_BYTES, 'Preparation request too large');
export const accountPreparationSchema = z.strictObject({
  workspaceId: accountIdSchema,
  accountId: accountIdSchema,
  pairingId: accountIdSchema,
  checkedAt: accountInstantSchema,
  authority: authorityStateSchema,
  executionVersion: revision,
  configuration: ownerSourceConfigurationSchema.nullable(),
  mailCursor: z.strictObject({ mailboxSubject: accountIdSchema, envelopeRevision: revision.positive().nullable(), scope: mailAccountScopeSchema.nullable() }).nullable(),
}).superRefine((value, ctx) => {
  const check = (valid: boolean) => { if (!valid) ctx.addIssue({ code: 'custom', message: 'Preparation identity mismatch' }); };
  check(bytes(value) <= ACCOUNT_PREPARATION_MAX_REPLY_BYTES);
  check(value.authority.accountId === value.accountId);
  const config = value.configuration;
  if (config) {
    check(config.workspaceId === value.workspaceId && config.accountId === value.accountId && config.pairingId === value.pairingId);
    check(config.research === null || config.research.workspaceId === value.workspaceId);
  }
  const subject = config?.mailboxSubject ?? null;
  check((subject === null) === (value.mailCursor === null));
  if (value.mailCursor) {
    const cursor = value.mailCursor;
    check(cursor.mailboxSubject === subject);
    check(cursor.envelopeRevision !== null || cursor.scope === null);
    if (cursor.scope) check(cursor.scope.accountId === value.accountId && cursor.scope.mailboxSubject === subject);
  }
});
export type GetAccountPreparation = z.infer<typeof getAccountPreparationSchema>;
export type AccountPreparationRequest = z.infer<typeof accountPreparationRequestSchema>;
export type AccountPreparation = z.infer<typeof accountPreparationSchema>;
export function accountPreparationReplySchema(request: GetAccountPreparation & { workspaceId?: string; pairingId?: string }) {
  return accountPreparationSchema.refine(value => value.accountId === request.accountId
    && (request.workspaceId === undefined || value.workspaceId === request.workspaceId)
    && (request.pairingId === undefined || value.pairingId === request.pairingId), 'Preparation response does not match request');
}
/** The only read-failure reasons the desktop surfaces: the worker's own codes from a small
 * non-OK `{ error }` body, plus a gateway that lacks the route (404). Anything else stays the
 * generic code and no body text is ever shown. The reason travels as the rejection message,
 * which is all the context bridge preserves of an Error. */
export const ACCOUNT_PREPARATION_MAX_ERROR_BYTES = 512;
export const accountPreparationReadReasonSchema = z.enum(['preparation_unavailable', 'worker_scope_denied', 'preparation_changed',
  'worker_unavailable', 'worker_invalid_request', 'worker_route_unavailable']);
export type AccountPreparationReadReason = z.infer<typeof accountPreparationReadReasonSchema>;
export const accountPreparationErrorBodySchema = z.object({ error: accountPreparationReadReasonSchema });
export class AccountPreparationReadFailure extends Error {
  constructor(readonly reason: AccountPreparationReadReason) { super(reason); this.name = 'AccountPreparationReadFailure'; }
}
export function accountPreparationReadReason(error: unknown): AccountPreparationReadReason | null {
  if (!(error instanceof Error)) return null;
  const parsed = accountPreparationReadReasonSchema.safeParse(error.message);
  return parsed.success ? parsed.data : null;
}
/** Bridge reply for one read: the preparation as read, or exactly one allowlisted reason. */
export const accountPreparationUnavailableSchema = z.strictObject({ unavailable: accountPreparationReadReasonSchema });
export const accountPreparationReadResultSchema = z.union([accountPreparationSchema, accountPreparationUnavailableSchema]);
export function accountPreparationReadReplySchema(request: GetAccountPreparation & { workspaceId?: string; pairingId?: string }) {
  return z.union([accountPreparationReplySchema(request), accountPreparationUnavailableSchema]);
}
