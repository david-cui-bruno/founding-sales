import { businessMetadataObservationSchema } from '@fss/contracts';
import { normalizeIdentityEndpoint } from '../crm/endpoints.ts';
import { createHash } from 'node:crypto';
import type { BusinessPolicy } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
const disclosureText = 'Callie may retain allowlisted business-mail metadata for owner-private review. Review decisions do not fetch message bodies, call hosted models, authorize outreach or enable broader acquisition. Original account identity and current connection generation are required. Broader capture requires separate disclosure, provider-policy, release and activation verification.';
export const METADATA_REVIEW_DISCLOSURE = { version: 'business-metadata-review-v1', sha256: createHash('sha256').update(disclosureText).digest('hex') } as const;
interface Mailbox {
  [key: string]: unknown;
  id: string;
  owner_user_id: string;
  email_address: string;
  provider_account_id: string | null;
  generation: number;
  status: string;
}
interface PolicyRow {
  [key: string]: unknown;
  revision: number;
  enabled: boolean;
  generation: number;
  account_binding: string;
  disclosure_version: string | null;
  disclosure_sha256: string | null;
}
export async function activeBusinessActor(context: RepositoryContext): Promise<boolean> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return false;
  const row = (await context.db.query<{
    role: string;
    status: string;
  }>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [context.scope.workspaceId, actor.userId])).rows[0];
  return row?.status === 'active' && row.role === actor.role;
}
export function businessAccountBinding(workspaceId: string, mailbox: Mailbox): string | null {
  return mailbox.provider_account_id === null ? null : createHash('sha256').update(JSON.stringify({ workspaceId, mailboxId: mailbox.id, ownerUserId: mailbox.owner_user_id, providerAccountId: mailbox.provider_account_id })).digest('hex');
}
async function lockMailbox(context: RepositoryContext, mailboxId?: string): Promise<Mailbox | null> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return null;
  const rows = (await context.db.query<Mailbox>(`SELECT id,owner_user_id,email_address,provider_account_id,generation,status FROM mailboxes WHERE workspace_id=$1 AND ${mailboxId === undefined ? 'owner_user_id=$2' : 'id=$2'} FOR NO KEY UPDATE`, [context.scope.workspaceId, mailboxId ?? actor.userId])).rows;
  const mailbox = rows[0];
  if (mailbox === undefined || actor.role !== 'admin' && mailbox.owner_user_id !== actor.userId || !await activeBusinessActor(context))
    return null;
  return mailbox;
}
export async function readBusinessPolicy(context: RepositoryContext, mailboxId?: string): Promise<BusinessPolicy | null> {
  const mailbox = await lockMailbox(context, mailboxId);
  if (mailbox === null && mailboxId !== undefined)
    return null;
  if (!await activeBusinessActor(context))
    return null;
  const row = mailbox === null ? undefined : (await context.db.query<PolicyRow>('SELECT revision,enabled,generation,account_binding,disclosure_version,disclosure_sha256 FROM crm_business_policies WHERE workspace_id=$1 AND mailbox_id=$2', [context.scope.workspaceId, mailbox.id])).rows[0];
  const accountBinding = mailbox === null ? null : businessAccountBinding(context.scope.workspaceId, mailbox);
  const disclosure = row?.disclosure_version === null || row?.disclosure_version === undefined || row.disclosure_sha256 === null ? null : { version: row.disclosure_version, sha256: row.disclosure_sha256 };
  const reasons: string[] = [];
  if (row === undefined)
    reasons.push('configuration_required');
  if (disclosure === null)
    reasons.push('disclosure_required');
  if (mailbox === null)
    reasons.push('mailbox_required');
  else if (mailbox.status !== 'connected')
    reasons.push('mailbox_disconnected');
  if (accountBinding === null)
    reasons.push('account_identity_required');
  if (row !== undefined && (row.account_binding !== accountBinding || row.generation !== mailbox?.generation))
    reasons.push('mailbox_binding_changed');
  reasons.push('provider_policy_verification_required', 'activation_not_available');
  if (context.scope.actor.kind === 'user' && context.scope.actor.role === 'admin' && mailbox !== null && mailbox.owner_user_id !== context.scope.actor.userId)
    await recordCrmAuditEvent(context, { action: 'crm.business_policy_read', subjectKind: 'mailbox', subjectId: mailbox.id });
  if (!await activeBusinessActor(context)) return null;
  return { mailboxId: mailbox?.id ?? null, ownerUserId: mailbox?.owner_user_id ?? null, emailAddress: mailbox?.email_address ?? null, generation: mailbox?.generation ?? null, accountBinding, revision: row?.revision ?? 0, enabled: row?.enabled ?? false, scopeDays: 90, classificationMode: 'metadata_only', disclosure, ready: false, reasons, metadataReviewDisclosureText: disclosureText, metadataReviewDisclosure: METADATA_REVIEW_DISCLOSURE };
}
export async function saveBusinessPolicy(context: RepositoryContext, input: {
  mailboxId: string;
  expectedGeneration: number;
  expectedAccountBinding: string;
  expectedRevision: number;
  enabled: boolean;
  disclosure: {
    version: string;
    sha256: string;
  } | null;
}) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return { ok: false as const, reason: 'business_owner_required' };
  const mailbox = await lockMailbox(context, input.mailboxId);
  if (mailbox === null || mailbox.owner_user_id !== actor.userId)
    return { ok: false as const, reason: 'business_owner_required' };
  if (input.enabled)
    return { ok: false as const, reason: 'activation_not_available' };
  const accountBinding = businessAccountBinding(context.scope.workspaceId, mailbox);
  if (mailbox.status !== 'connected' || accountBinding === null)
    return { ok: false as const, reason: 'mailbox_unavailable' };
  if (mailbox.generation !== input.expectedGeneration || accountBinding !== input.expectedAccountBinding)
    return { ok: false as const, reason: 'mailbox_binding_changed' };
  if (input.disclosure !== null && (input.disclosure.version !== METADATA_REVIEW_DISCLOSURE.version || input.disclosure.sha256 !== METADATA_REVIEW_DISCLOSURE.sha256))
    return { ok: false as const, reason: 'disclosure_unrecognized' };
  const old = (await context.db.query<{
    revision: number;
  }>('SELECT revision FROM crm_business_policies WHERE workspace_id=$1 AND mailbox_id=$2 FOR UPDATE', [context.scope.workspaceId, mailbox.id])).rows[0];
  if ((old?.revision ?? 0) !== input.expectedRevision)
    return { ok: false as const, reason: 'stale_revision' };
  if (!await activeBusinessActor(context))
    return { ok: false as const, reason: 'business_owner_required' };
  const revision = input.expectedRevision + 1;
  await context.db.query(`INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,disclosure_version,disclosure_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8,$9) ON CONFLICT(workspace_id,mailbox_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id,provider_account_id=EXCLUDED.provider_account_id,account_binding=EXCLUDED.account_binding,generation=EXCLUDED.generation,revision=EXCLUDED.revision,enabled=false,disclosure_version=EXCLUDED.disclosure_version,disclosure_sha256=EXCLUDED.disclosure_sha256`, [context.scope.workspaceId, mailbox.id, mailbox.owner_user_id, mailbox.provider_account_id, accountBinding, mailbox.generation, revision, input.disclosure?.version ?? null, input.disclosure?.sha256 ?? null]);
  await recordCrmAuditEvent(context, { action: 'crm.business_policy_saved', subjectKind: 'mailbox', subjectId: mailbox.id, detail: { revision, enabled: false, generation: mailbox.generation, accountBinding, disclosureVersion: input.disclosure?.version ?? null } });
  return { ok: true as const, value: { revision } };
}
export interface BusinessMetadataObservation {
  mailboxId: string;
  providerAccountId: string;
  generation: number;
  expectedPolicyRevision: number;
  providerThreadId: string;
  providerMessageId: string;
  subject: string;
  participants: string[];
  latestProviderAt: string;
  category: 'business' | 'uncertain' | 'personal' | 'newsletter' | 'receipt' | 'routine_support';
  reason: string;
  classifierVersion: string;
}
export async function observeBusinessMetadata(context: RepositoryContext, observation: unknown) {
  const actor = context.scope.actor;
  if (actor.kind !== 'system' || actor.component !== 'worker')
    return { ok: false as const, reason: 'system_observer_required' };
  const parsed = businessMetadataObservationSchema.safeParse(observation);
  if (!parsed.success)
    return { ok: false as const, reason: 'invalid_metadata' };
  const input = parsed.data;
  const mailbox = (await context.db.query<Mailbox>('SELECT id,owner_user_id,email_address,provider_account_id,generation,status FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE', [context.scope.workspaceId, input.mailboxId])).rows[0];
  if (mailbox === undefined || mailbox.status !== 'connected' || mailbox.provider_account_id !== input.providerAccountId || mailbox.generation !== input.generation)
    return { ok: false as const, reason: 'mailbox_binding_changed' };
  const policy = (await context.db.query<PolicyRow>('SELECT revision,enabled,generation,account_binding,disclosure_version,disclosure_sha256 FROM crm_business_policies WHERE workspace_id=$1 AND mailbox_id=$2', [context.scope.workspaceId, mailbox.id])).rows[0];
  const binding = businessAccountBinding(context.scope.workspaceId, mailbox);
  if (policy === undefined || policy.revision !== input.expectedPolicyRevision || policy.generation !== mailbox.generation || policy.account_binding !== binding || policy.disclosure_version !== METADATA_REVIEW_DISCLOSURE.version || policy.disclosure_sha256 !== METADATA_REVIEW_DISCLOSURE.sha256)
    return { ok: false as const, reason: 'metadata_review_unavailable' };
  const owner = (await context.db.query<{
    status: string;
  }>('SELECT status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [context.scope.workspaceId, mailbox.owner_user_id])).rows[0];
  if (owner?.status !== 'active')
    return { ok: false as const, reason: 'metadata_review_unavailable' };
  const instant = new Date(input.latestProviderAt);
  if (!Number.isFinite(instant.getTime()) || input.providerThreadId.length < 1 || input.providerThreadId.length > 320 || input.providerMessageId.length < 1 || input.providerMessageId.length > 320 || input.subject.length > 500 || input.participants.length > 50 || input.participants.some(value => value.length < 1 || value.length > 320) || input.reason.length < 1 || input.reason.length > 100 || input.classifierVersion.length < 1 || input.classifierVersion.length > 100)
    return { ok: false as const, reason: 'invalid_metadata' };
  const now = (await context.db.query<{
    now: Date;
  }>('SELECT clock_timestamp() AS now')).rows[0]?.now;
  if (now === undefined || instant.getTime() < now.getTime() - 90 * 86400000 || instant.getTime() > now.getTime() + 86400000)
    return { ok: false as const, reason: 'outside_review_window' };
  const participants = input.participants.map(value => normalizeIdentityEndpoint('email', value));
  if (participants.some(value => value === null))
    return { ok: false as const, reason: 'invalid_metadata' };
  const existing = (await context.db.query<{
    id: string;
    metadata_revision: number;
    metadata_availability: string;
  }>('SELECT id,metadata_revision,metadata_availability FROM crm_business_conversations WHERE workspace_id=$1 AND mailbox_id=$2 AND account_binding=$3 AND provider_thread_id=$4 FOR UPDATE', [context.scope.workspaceId, mailbox.id, binding, input.providerThreadId])).rows[0];
  if (existing?.metadata_availability === 'deleted')
    return { ok: false as const, reason: 'metadata_deleted' };
  const currentOwner = (await context.db.query<{
    status: string;
  }>('SELECT status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [context.scope.workspaceId, mailbox.owner_user_id])).rows[0];
  if (currentOwner?.status !== 'active')
    return { ok: false as const, reason: 'metadata_review_unavailable' };
  const hash = createHash('sha256').update(JSON.stringify({ subject: input.subject, participants, at: instant.toISOString(), category: input.category, reason: input.reason, classifier: input.classifierVersion })).digest('hex');
  const result = (await context.db.query<{
    id: string;
    metadata_revision: number;
  }>(`INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12) ON CONFLICT(workspace_id,mailbox_id,account_binding,provider_thread_id) DO UPDATE SET subject=EXCLUDED.subject,participants=EXCLUDED.participants,latest_provider_at=EXCLUDED.latest_provider_at,category=EXCLUDED.category,reason=EXCLUDED.reason,classifier_version=EXCLUDED.classifier_version,metadata_hash=EXCLUDED.metadata_hash,metadata_revision=crm_business_conversations.metadata_revision+1 WHERE crm_business_conversations.metadata_availability='available' AND crm_business_conversations.metadata_hash<>EXCLUDED.metadata_hash AND crm_business_conversations.latest_provider_at<=EXCLUDED.latest_provider_at RETURNING id,metadata_revision`, [context.scope.workspaceId, mailbox.id, mailbox.owner_user_id, binding, input.providerThreadId, input.subject, JSON.stringify(participants), instant.toISOString(), input.category, input.reason, input.classifierVersion, hash])).rows[0];
  return { ok: true as const, value: { conversationId: result?.id ?? existing?.id ?? null, metadataRevision: result?.metadata_revision ?? existing?.metadata_revision ?? null, captureAllowed: false as const } };
}
import type { BusinessReviewPage } from '@fss/contracts';
export async function readBusinessReview(context: RepositoryContext, input: {
  mailboxId: string;
  after?: string | undefined;
  limit: number;
}): Promise<BusinessReviewPage | null> {
  const policy = await readBusinessPolicy(context, input.mailboxId);
  if (policy === null)
    return null;
  const reasons = policy.reasons.filter(reason => reason !== 'provider_policy_verification_required' && reason !== 'activation_not_available');
  const available = reasons.length === 0;
  const rows = available ? (await context.db.query<{
    id: string;
    subject: string;
    participants: string[];
    latest_provider_at: Date;
    category: BusinessMetadataObservation['category'];
    reason: string;
    metadata_revision: number;
    decision_revision: number;
    human_decision: 'include' | 'exclude' | null;
  }>(`SELECT id,subject,participants,latest_provider_at,category,reason,metadata_revision,decision_revision,human_decision FROM crm_business_conversations WHERE workspace_id=$1 AND mailbox_id=$2 AND account_binding=$3 AND owner_user_id=$4 AND ($5::uuid IS NULL OR id>$5) AND metadata_availability='available' AND latest_provider_at>=clock_timestamp()-interval '90 days' ORDER BY id LIMIT $6 FOR SHARE`, [context.scope.workspaceId, input.mailboxId, policy.accountBinding, policy.ownerUserId, input.after ?? null, input.limit + 1])).rows : [];
  if (!await activeBusinessActor(context))
    return null;
  const page = rows.slice(0, input.limit);
  return { available, reasons, mailboxId: input.mailboxId, accountBinding: policy.accountBinding, generation: policy.generation, policyRevision: policy.revision, captureAllowed: false, conversations: page.map(row => ({ conversationId: row.id, subject: row.subject, participants: row.participants, latestProviderAt: row.latest_provider_at.toISOString(), category: row.category, reason: row.reason, metadataRevision: row.metadata_revision, decisionRevision: row.decision_revision, humanDecision: row.human_decision, effectiveDecision: row.human_decision === 'include' ? 'included' : row.human_decision === 'exclude' ? 'excluded' : row.category === 'business' ? 'included' : row.category === 'uncertain' ? 'needs_review' : 'excluded', captureAllowed: false })), nextAfter: rows.length > input.limit ? page.at(-1)?.id ?? null : null };
}
export async function decideBusinessReview(context: RepositoryContext, input: {
  mailboxId: string;
  conversationId: string;
  expectedAccountBinding: string;
  expectedGeneration: number;
  expectedPolicyRevision: number;
  expectedMetadataRevision: number;
  expectedDecisionRevision: number;
  decision: 'include' | 'exclude';
}) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return { ok: false as const, reason: 'business_owner_required' };
  const policy = await readBusinessPolicy(context, input.mailboxId);
  if (policy === null || policy.ownerUserId !== actor.userId)
    return { ok: false as const, reason: 'business_owner_required' };
  if (policy.generation !== input.expectedGeneration || policy.accountBinding !== input.expectedAccountBinding)
    return { ok: false as const, reason: 'mailbox_binding_changed' };
  if (policy.revision !== input.expectedPolicyRevision)
    return { ok: false as const, reason: 'stale_policy' };
  if (policy.reasons.some(reason => reason !== 'activation_not_available' && reason !== 'provider_policy_verification_required'))
    return { ok: false as const, reason: 'metadata_review_unavailable' };
  const row = (await context.db.query<{
    metadata_revision: number;
    decision_revision: number;
  }>(`SELECT metadata_revision,decision_revision FROM crm_business_conversations WHERE workspace_id=$1 AND id=$2 AND mailbox_id=$3 AND account_binding=$4 AND owner_user_id=$5 AND metadata_availability='available' AND latest_provider_at>=clock_timestamp()-interval '90 days' FOR UPDATE`, [context.scope.workspaceId, input.conversationId, input.mailboxId, input.expectedAccountBinding, actor.userId])).rows[0];
  if (row === undefined)
    return { ok: false as const, reason: 'conversation_unavailable' };
  if (row.metadata_revision !== input.expectedMetadataRevision)
    return { ok: false as const, reason: 'stale_metadata' };
  if (row.decision_revision !== input.expectedDecisionRevision)
    return { ok: false as const, reason: 'stale_decision' };
  if (!await activeBusinessActor(context))
    return { ok: false as const, reason: 'business_owner_required' };
  const revision = row.decision_revision + 1;
  await context.db.query('UPDATE crm_business_conversations SET human_decision=$3,decision_revision=$4 WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, input.conversationId, input.decision, revision]);
  await context.db.query('INSERT INTO crm_business_decision_revisions(workspace_id,conversation_id,revision,metadata_revision,policy_revision,actor_user_id,decision) VALUES($1,$2,$3,$4,$5,$6,$7)', [context.scope.workspaceId, input.conversationId, revision, row.metadata_revision, policy.revision, actor.userId, input.decision]);
  await recordCrmAuditEvent(context, { action: 'crm.business_review_decided', subjectKind: 'business_conversation', subjectId: input.conversationId, detail: { decision: input.decision, decisionRevision: revision, metadataRevision: row.metadata_revision, policyRevision: policy.revision } });
  return { ok: true as const, value: { decisionRevision: revision, captureAllowed: false as const } };
}
/** Whole metadata-copy deletion, with opaque no-resurrection identity and body-free decisions retained. */
export async function redactBusinessMetadata(context: RepositoryContext, input: {
  conversationIds?: readonly string[];
  targetAddresses?: readonly string[];
  expiredOnly?: boolean;
}) {
  const actor = context.scope.actor;
  if (!(actor.kind === 'system' && actor.component === 'worker') && !(actor.kind === 'user' && actor.role === 'admin' && await activeBusinessActor(context)))
    return { ok: false as const, reason: 'metadata_deletion_denied' };
  const ids = input.conversationIds ?? [];
  const addresses = (input.targetAddresses ?? []).map(value => normalizeIdentityEndpoint('email', value));
  if (ids.length > 100 || addresses.length > 100 || addresses.some(value => value === null) || ids.length === 0 && addresses.length === 0 && !input.expiredOnly)
    return { ok: false as const, reason: 'metadata_deletion_scope_invalid' };
  const rows = (await context.db.query<{
    id: string;
  }>(`SELECT id FROM crm_business_conversations WHERE workspace_id=$1 AND metadata_availability='available' AND (id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(participants) AS address WHERE address=ANY($3::text[])) OR ($4 AND latest_provider_at<clock_timestamp()-interval '90 days')) ORDER BY id LIMIT ${input.expiredOnly && ids.length === 0 && addresses.length === 0 ? 100 : 101} FOR UPDATE`, [context.scope.workspaceId, ids, addresses, input.expiredOnly ?? false])).rows;
  if (rows.length > 100)
    return { ok: false as const, reason: 'metadata_deletion_scope_limit' };
  if (actor.kind === 'user' && !await activeBusinessActor(context))
    return { ok: false as const, reason: 'metadata_deletion_denied' };
  await context.db.query("UPDATE crm_business_conversations SET metadata_availability='deleted',subject='',participants='[]'::jsonb,latest_provider_at=NULL,category='uncertain',reason='metadata_deleted',classifier_version='redacted',metadata_hash=repeat('0',64),metadata_revision=metadata_revision+1 WHERE workspace_id=$1 AND id=ANY($2::uuid[])", [context.scope.workspaceId, rows.map(row => row.id)]);
  return { ok: true as const, value: { redacted: rows.length, conversationIds: rows.map(row => row.id) } };
}
