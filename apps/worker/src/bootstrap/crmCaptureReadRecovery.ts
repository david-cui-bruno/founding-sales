import { withTransaction } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { recoveryCurrent, type CaptureReadProbeDeps } from '@fss/domain/mail/crmCaptureReadProbe.ts';
import type { RecoveryRow } from '@fss/domain/mail/crmCaptureReadRecovery.ts';
import { readRefreshToken } from '@fss/domain/mail/tokens.ts';
import type { CrmAuthoritySessions } from '@fss/domain/crm/capabilityVerifiers.ts';
import type { MailCaptureProvider, MailCaptureProof, MailCaptureProofVerifier } from '@fss/domain/mail/crmSources.ts';
import { createGmailMailCaptureProvider } from '@fss/domain/mail/crmGmailProvider.ts';
import { crmCaptureReadRecoveryHandler } from '../handlers/crmCaptureReadRecovery.ts';
import { crmCaptureReadForwardHandler } from '../handlers/crmCaptureReadForward.ts';
import type { CaptureReadForwardDeps } from '@fss/domain/mail/crmCaptureReadForward.ts';
import type { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import type { RepositoryContext } from '@fss/domain/db/workspaceScope.ts';

type Options = CaptureReadProbeDeps & CrmAuthoritySessions;
type ForwardInput = Parameters<MailCaptureProvider['read']>[0];
type AccessResolver = Parameters<typeof createGmailMailCaptureProvider>[0]['resolveAccess'];
export interface CaptureReadComposition { crmCaptureRead?: CaptureReadForwardDeps }
export function registerCaptureReadHandlers(registry: HandlerRegistry, composition: CaptureReadComposition) {
 registry.register(crmCaptureReadRecoveryHandler(composition.crmCaptureRead));
 registry.register(crmCaptureReadForwardHandler(composition.crmCaptureRead));
}
async function verified(context: RepositoryContext, input: ForwardInput, options: Options) {
 const proof = input.expectedProof;
 if (!proof?.ownerApprovalId || !proof.forwardScope) return null;
 const row = (await context.db.query<RecoveryRow>(`SELECT r.* FROM crm_capture_read_recoveries r
  JOIN crm_capture_read_progress p ON p.workspace_id=r.workspace_id AND p.recovery_id=r.id
  WHERE r.workspace_id=$1 AND r.mailbox_id=$2 AND r.generation=$3 AND r.state='verified'
  AND p.state NOT IN ('blocked','uncertain') ORDER BY r.requested_at DESC LIMIT 1 FOR SHARE OF r,p`,
  [input.workspaceId, input.mailboxId, input.generation])).rows[0];
 const a = row ? await recoveryCurrent(context, row, options.runtime) : null;
 if (!a || a.providerAccountId !== input.providerAccountId || a.ownerApprovalId !== proof.ownerApprovalId
  || a.ownerUserId !== proof.ownerUserId || a.controlsRevision !== proof.controlsRevision
  || a.policyRevision !== proof.policyRevision || a.cutoff !== proof.forwardScope.enabledAt) return null;
 return { row: row!, authority: a };
}
async function open(options: Options, workspaceId: string) {
 const opened = await options.openSession();
 return { ...opened, context: repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), opened.session) };
}
async function blockConsumer(options: Options, input: ForwardInput, reason: 'provider_refused' | 'provider_uncertain') {
 const opened = await open(options, input.workspaceId);
 try {
  await withTransaction(opened.session, () => opened.context.db.query(`UPDATE crm_capture_read_progress
   SET state=$4,coded_reason=$5,revision=revision+1 WHERE workspace_id=$1 AND mailbox_id=$2
   AND generation=$3 AND state NOT IN ('blocked','uncertain')`,
   [input.workspaceId, input.mailboxId, input.generation, reason === 'provider_uncertain' ? 'uncertain' : 'blocked', reason]));
 } finally { await opened.close(); }
}
/** Only normal forward body capture receives this resolver. Backfill, diagnostics,
 * selection, generic mail sync and outbound retain their original resolver. */
export function createCaptureReadAccessResolver(options: Options): AccessResolver {
 return async input => {
  const opened = await open(options, input.workspaceId);
  try {
   const current = () => withTransaction(opened.session, () => verified(opened.context, input, options));
   const before = await current();
   if (!before) return null;
   const token = await readRefreshToken(opened.context, { mailboxId: input.mailboxId, cipher: options.cipher });
   const same = async () => { const after = await current(); return after?.row.id === before.row.id && after.authority.binding === before.authority.binding; };
   if (token === null || !await same()) return null;
   const access = await options.gmail.refreshAccessToken(options.oauth, token);
   if (!await same()) return null;
   if (!access.ok || !Number.isFinite(access.grant.expiresAtEpochSeconds) || access.grant.expiresAtEpochSeconds <= Date.now() / 1000
    || access.grant.grantedScopes && !access.grant.grantedScopes.includes('https://www.googleapis.com/auth/gmail.readonly')) {
    await blockConsumer(options, input, 'provider_refused');
    return null;
   }
   return { mailboxId: input.mailboxId, providerAccountId: input.providerAccountId, generation: input.generation, mailboxEmail: before.authority.mailboxEmail, access: access.grant };
  } catch {
   await blockConsumer(options, input, 'provider_uncertain');
   return null;
  } finally { await opened.close(); }
 };
}
/** Each normal provider authorizeRead checkpoint also validates recovery after a
 * metadata wait and BEFORE a body read, not just at the final OAuth recheck. */
export function createCaptureReadForwardProvider(options: Options & { ordinaryResolveAccess: AccessResolver; proofVerifier: MailCaptureProofVerifier }): MailCaptureProvider {
 const recovery = createCaptureReadAccessResolver(options);
 async function authorize(proof: MailCaptureProof) {
  if (!await options.proofVerifier.verify(proof)) return false;
  const opened = await open(options, proof.workspaceId);
  try {
   return await withTransaction(opened.session, async () => {
    const incidents = await opened.context.db.query('SELECT id FROM mailbox_provider_incidents WHERE workspace_id=$1 AND mailbox_id=$2 AND resolved_at IS NULL LIMIT 1', [proof.workspaceId, proof.mailboxId]);
    if (!incidents.rows.length) return true;
    return !!await verified(opened.context, { workspaceId: proof.workspaceId, mailboxId: proof.mailboxId, providerAccountId: proof.providerAccountId, generation: proof.generation, providerMessageId: 'authorization-check', expectedProof: proof }, options);
   });
  } finally { await opened.close(); }
 }
 const provider = createGmailMailCaptureProvider({ gmail: options.gmail, resolveAccess: async input => await recovery(input) ?? options.ordinaryResolveAccess(input), authorizeRead: authorize });
 return { async read(input) {
  try { return await provider.read(input); }
  catch { await blockConsumer(options, input, 'provider_uncertain'); throw new Error('capture_read_consumer_unavailable'); }
 } };
}
