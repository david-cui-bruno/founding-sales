import { businessMetadataObservationSchema } from '@fss/contracts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { isSuppressed } from '../suppression/effective.ts';
import { workspaceScope, repositoryContext } from '../db/workspaceScope.ts';
import {
  lockBusinessMetadataAddresses,
  observeBusinessMetadata,
} from '../business/acquisition.ts';
import { headerValue } from './gmailClient.ts';
import type { GmailMessageMetadata } from './gmailClient.ts';
import type { BusinessMailMetadataObserver } from './pipeline.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  activeBusinessActor,
  businessAccountBinding,
} from '../business/acquisition.ts';
import { normalizeIdentityEndpoint } from '../crm/endpoints.ts';
import { lockIdentityContext } from '../crm/identityAccess.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { withTransaction } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { JobHandler, JobHandlerInput } from '../jobs/handlerRegistry.ts';

export const MAIL_CAPTURE_VERSION = 'crm-mail-capture-v1';
export interface MailCaptureProof {
  workspaceId: string;
  mailboxId: string;
  ownerUserId: string;
  providerAccountId: string;
  accountBinding: string;
  generation: number;
  controlsRevision: number;
  policyRevision: number;
  disclosureVersion: string;
  disclosureSha256: string;
  grantReceipt: string;
  providerPolicyReceipt: string;
  evaluationReceipt: string;
  releaseReceipt: string;
  captureVersion: typeof MAIL_CAPTURE_VERSION;
}
export interface MailCaptureProofVerifier {
  /** Receipt references must resolve to immutable, unrevoked proof for every exact binding. */
  verify(proof: MailCaptureProof): Promise<boolean>;
}
const providerMessageSchema = z
  .object({
    providerAccountId: z.string().min(1).max(320),
    messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
    threadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
    labels: z.array(z.string().max(100)).max(100),
    origin: z
      .enum(['received', 'sent', 'imported', 'unknown'])
      .default('unknown'),
    providerAt: z.string().datetime(),
    rawSenderDate: z.string().max(200).nullable(),
    from: z.string().max(320),
    fromDisplayName: z.string().max(240).optional(),
    to: z.array(z.string().max(320)).max(25),
    cc: z.array(z.string().max(320)).max(24),
    subject: z.string().max(998),
    body: z.string().max(200000).nullable(),
    parserVersion: z.string().min(1).max(100),
    representation: z.enum(['plain_text', 'html_flattened']),
    completeness: z.enum(['complete', 'partial', 'unavailable']),
    ranges: z
      .array(
        z
          .object({
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
            kind: z.enum(['authored', 'quoted', 'forwarded', 'unknown']),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type CapturedMailMessage = z.input<typeof providerMessageSchema>;
export interface MailCaptureProvider {
  /** A read must report actual response account/message identity, never substitute the request ID. */
  read(input: {
    mailboxId: string;
    providerMessageId: string;
    providerAccountId: string;
    generation: number;
  }): Promise<CapturedMailMessage>;
}
const payloadSchema = z
  .object({
    mailboxId: z.string().uuid(),
    providerMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
    providerAccountId: z.string().min(1).max(320),
    generation: z.number().int().positive(),
    conversationId: z.string().uuid(),
    controlsRevision: z.number().int().positive(),
    policyRevision: z.number().int().positive(),
    decisionRevision: z.number().int().nonnegative(),
    recapture: z
      .object({
        sourceId: z.string().uuid(),
        expectedRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
type CapturePayload = z.infer<typeof payloadSchema>;
interface Control extends Record<string, unknown> {
  enabled: boolean;
  revision: number;
  owner_user_id: string;
  provider_account_id: string;
  account_binding: string;
  generation: number;
  policy_revision: number;
  disclosure_version: string;
  disclosure_sha256: string;
  grant_receipt: string;
  provider_policy_receipt: string;
  evaluation_receipt: string;
  release_receipt: string;
}
interface Mailbox extends Record<string, unknown> {
  id: string;
  owner_user_id: string;
  email_address: string;
  provider_account_id: string | null;
  generation: number;
  status: string;
}
interface Conversation extends Record<string, unknown> {
  id: string;
  owner_user_id: string;
  account_binding: string;
  provider_thread_id: string;
  metadata_availability: string;
  category: string;
  human_decision: string | null;
  decision_revision: number;
}
interface CaptureAuthority {
  mailboxEmail: string;
  proof: MailCaptureProof;
  conversation: Conversation;
}
const done = (outcome: string, extra: Record<string, unknown> = {}) => ({
  done: true,
  progress: { outcome, ...extra },
});

async function lockCaptureAuthority(
  input: JobHandlerInput,
  payload: CapturePayload,
  lockConversation = false,
  beforeConversation?: () => Promise<boolean>,
): Promise<CaptureAuthority | null> {
  const { session: db, scope, job } = input;
  if (
    scope.actor.kind !== 'system' ||
    scope.actor.component !== 'worker' ||
    scope.workspaceId !== job.workspaceId
  )
    return null;
  const lease = await db.query(
    "SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>now() FOR UPDATE",
    [scope.workspaceId, job.id, job.leaseOwner, job.fencingToken],
  );
  if (!lease.rows.length) return null;
  const mailbox = (
    await db.query<Mailbox>(
      'SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE',
      [scope.workspaceId, payload.mailboxId],
    )
  ).rows[0];
  if (
    !mailbox ||
    mailbox.status !== 'connected' ||
    mailbox.generation !== payload.generation ||
    mailbox.provider_account_id !== payload.providerAccountId
  )
    return null;
  const owner = await db.query(
    "SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",
    [scope.workspaceId, mailbox.owner_user_id],
  );
  if (!owner.rows.length) return null;
  const control = (
    await db.query<Control>(
      'SELECT * FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2 FOR UPDATE',
      [scope.workspaceId, mailbox.id],
    )
  ).rows[0];
  const binding = businessAccountBinding(scope.workspaceId, mailbox);
  if (
    !control?.enabled ||
    control.revision !== payload.controlsRevision ||
    control.generation !== payload.generation ||
    control.owner_user_id !== mailbox.owner_user_id ||
    control.provider_account_id !== payload.providerAccountId ||
    control.account_binding !== binding ||
    control.policy_revision !== payload.policyRevision
  )
    return null;
  const policy = await db.query(
    'SELECT 1 FROM crm_business_policies WHERE workspace_id=$1 AND mailbox_id=$2 AND revision=$3 AND account_binding=$4 AND generation=$5 AND owner_user_id=$6 FOR SHARE',
    [
      scope.workspaceId,
      mailbox.id,
      payload.policyRevision,
      binding,
      payload.generation,
      mailbox.owner_user_id,
    ],
  );
  if (!policy.rows.length) return null;
  if (beforeConversation && !(await beforeConversation())) return null;
  const conversation = (
    await db.query<Conversation>(
      `SELECT * FROM crm_business_conversations WHERE workspace_id=$1 AND id=$2 AND mailbox_id=$3 ${lockConversation ? 'FOR UPDATE' : ''}`,
      [scope.workspaceId, payload.conversationId, mailbox.id],
    )
  ).rows[0];
  if (
    !conversation ||
    conversation.owner_user_id !== mailbox.owner_user_id ||
    conversation.account_binding !== binding ||
    conversation.metadata_availability !== 'available' ||
    conversation.decision_revision !== payload.decisionRevision ||
    !(
      conversation.human_decision === 'include' ||
      (conversation.human_decision === null &&
        conversation.category === 'business')
    )
  )
    return null;
  return {
    conversation,
    mailboxEmail: mailbox.email_address,
    proof: {
      workspaceId: scope.workspaceId,
      mailboxId: mailbox.id,
      ownerUserId: mailbox.owner_user_id,
      providerAccountId: payload.providerAccountId,
      accountBinding: binding!,
      generation: payload.generation,
      controlsRevision: control.revision,
      policyRevision: control.policy_revision,
      disclosureVersion: control.disclosure_version,
      disclosureSha256: control.disclosure_sha256,
      grantReceipt: control.grant_receipt,
      providerPolicyReceipt: control.provider_policy_receipt,
      evaluationReceipt: control.evaluation_receipt,
      releaseReceipt: control.release_receipt,
      captureVersion: MAIL_CAPTURE_VERSION,
    },
  };
}

/** Provider work is outside database transactions; apply repeats exact authority and lease fences. */
async function validExplicitMailRecapture(
  input: JobHandlerInput,
  payload: CapturePayload,
  identityId: string,
  proof: MailCaptureProof,
) {
  if (!payload.recapture) return false;
  const { sourceId, expectedRevision } = payload.recapture;
  return (
    (
      await input.session.query(
        `SELECT 1 FROM crm_mail_sources s JOIN crm_mail_acquisition_tombstones t ON t.workspace_id=s.workspace_id AND t.source_id=s.source_id AND t.source_revision=s.source_revision WHERE s.workspace_id=$1 AND s.source_id=$2 AND s.source_revision=$3 AND s.capture_identity_id=$4 AND s.owner_user_id=$5 AND s.account_binding=$6 AND s.availability='awaiting_recapture' AND t.availability='awaiting_recapture' AND NOT EXISTS(SELECT 1 FROM crm_mail_acquisition_tombstones newer WHERE newer.workspace_id=t.workspace_id AND newer.source_id=t.source_id AND newer.source_revision>t.source_revision)`,
        [
          input.scope.workspaceId,
          sourceId,
          expectedRevision,
          identityId,
          proof.ownerUserId,
          proof.accountBinding,
        ],
      )
    ).rows.length === 1
  );
}

export function businessMailCaptureHandler(deps: {
  provider: MailCaptureProvider;
  proofVerifier?: MailCaptureProofVerifier;
}): JobHandler {
  return {
    kind: 'crm.mail_capture',
    protection: 'outbound_fence',
    maxAttempts: 4,
    leaseSeconds: 120,
    async handle(input) {
      const parsed = payloadSchema.safeParse(input.job.payload);
      // No verifier is an unconditional disabled composition, even if a database row was toggled.
      if (!deps.proofVerifier) return done('acquisition_disabled');
      if (!parsed.success) return done('invalid_capture_payload');
      const payload = parsed.data;
      const staged = await withTransaction(input.session, async () => {
        const original = await lockOriginalMailContexts(input, payload);
        if (!original) return null;
        const authority = await lockCaptureAuthority(input, payload, true);
        if (!authority) return null;
        await input.session.query(
          "INSERT INTO crm_mail_capture_identities(workspace_id,mailbox_id,account_binding,provider_message_id,lease_fencing_token,job_id,state) VALUES($1,$2,$3,$4,$5::bigint,$6,'pending') ON CONFLICT(workspace_id,mailbox_id,account_binding,provider_message_id) DO NOTHING",
          [
            input.scope.workspaceId,
            payload.mailboxId,
            authority.proof.accountBinding,
            payload.providerMessageId,
            input.job.fencingToken,
            input.job.id,
          ],
        );
        const identity = (
          await input.session.query<{
            id: string;
            state: string;
            source_id: string | null;
            context_snapshot: OriginalMailMatch[];
          }>(
            'SELECT id,state,source_id,context_snapshot FROM crm_mail_capture_identities WHERE workspace_id=$1 AND mailbox_id=$2 AND account_binding=$3 AND provider_message_id=$4 FOR UPDATE',
            [
              input.scope.workspaceId,
              payload.mailboxId,
              authority.proof.accountBinding,
              payload.providerMessageId,
            ],
          )
        ).rows[0]!;
        const recaptureAllowed = await validExplicitMailRecapture(
          input,
          payload,
          identity.id,
          authority.proof,
        );
        const deleted = await input.session.query(
          'SELECT 1 FROM crm_mail_acquisition_tombstones WHERE workspace_id=$1 AND capture_identity_id=$2',
          [input.scope.workspaceId, identity.id],
        );
        if (
          (deleted.rows.length && !recaptureAllowed) ||
          identity.state === 'blocked' ||
          (payload.recapture && !recaptureAllowed)
        )
          return { outcome: 'source_deleted' } as const;
        if (identity.state === 'copied' && !recaptureAllowed)
          return {
            outcome: 'already_captured',
            sourceId: identity.source_id,
          } as const;
        await input.session.query(
          'UPDATE crm_mail_capture_identities SET job_id=$3,lease_fencing_token=$4::bigint WHERE workspace_id=$1 AND id=$2',
          [
            input.scope.workspaceId,
            identity.id,
            input.job.id,
            input.job.fencingToken,
          ],
        );
        if (
          identity.source_id !== null &&
          identity.source_id !== original.messageId &&
          !(
            recaptureAllowed &&
            original.messageId === null &&
            identity.source_id === payload.recapture?.sourceId
          )
        )
          return { outcome: 'source_deleted' } as const;
        if (
          identity.source_id !== null &&
          JSON.stringify(identity.context_snapshot) !==
            JSON.stringify(original.matches)
        )
          return { outcome: 'source_context_changed' } as const;
        await input.session.query(
          'UPDATE crm_mail_capture_identities SET source_id=$3,context_snapshot=$4::jsonb WHERE workspace_id=$1 AND id=$2',
          [
            input.scope.workspaceId,
            identity.id,
            recaptureAllowed ? payload.recapture!.sourceId : original.messageId,
            JSON.stringify(original.matches),
          ],
        );
        return { authority, identityId: identity.id, original };
      });
      if (!staged) return done('authority_unavailable');
      if ('outcome' in staged)
        return done(
          staged.outcome,
          'sourceId' in staged ? { sourceId: staged.sourceId } : {},
        );
      if (!(await deps.proofVerifier.verify(staged.authority.proof)))
        return done('verification_unavailable');
      const message = providerMessageSchema.safeParse(
        await deps.provider.read({
          mailboxId: payload.mailboxId,
          providerMessageId: payload.providerMessageId,
          providerAccountId: payload.providerAccountId,
          generation: payload.generation,
        }),
      );
      if (!message.success) return done('provider_evidence_invalid');
      const m = message.data;
      if (
        m.providerAccountId !== payload.providerAccountId ||
        m.messageId !== payload.providerMessageId ||
        m.threadId !== staged.authority.conversation.provider_thread_id
      )
        return done('account_identity_conflict');
      if (
        (m.body === null && m.completeness !== 'unavailable') ||
        (m.body !== null && m.completeness === 'unavailable') ||
        (m.representation === 'html_flattened' && m.completeness === 'complete')
      )
        return done('provider_evidence_invalid');
      if (
        m.ranges.some(
          (r, i) =>
            r.end <= r.start ||
            r.end > (m.body?.length ?? 0) ||
            (i > 0 && r.start < m.ranges[i - 1]!.end),
        )
      )
        return done('provider_evidence_invalid');
      const participants = [m.from, ...m.to, ...m.cc].map((value) =>
        normalizeIdentityEndpoint('email', value),
      );
      if (participants.some((value) => value === null))
        return done('provider_evidence_invalid');
      if (!(await deps.proofVerifier.verify(staged.authority.proof)))
        return done('verification_unavailable');
      return withTransaction(input.session, async () => {
        const senderEndpoint = participants[0]!;
        const senderHash = createHash('sha256')
          .update(senderEndpoint)
          .digest('hex');
        const observedLabel = m.fromDisplayName?.trim();
        const safeLabel =
          observedLabel !== undefined &&
          /^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,119}$/u.test(observedLabel);
        // Only capture writers use this private continuity key; deletion never
        // waits on it, and still wins through address and source tombstones.
        await input.session.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [
            `${input.scope.workspaceId}:mail-observed-person:${staged.authority.proof.ownerUserId}:${staged.authority.proof.accountBinding}:${senderHash}`,
          ],
        );
        const original = await lockOriginalMailContexts(input, payload);
        if (
          !original ||
          JSON.stringify(original) !== JSON.stringify(staged.original)
        )
          return done('source_context_changed');
        const knownIdentity =
          (
            await input.session.query(
              `SELECT 1 FROM crm_identity_endpoints e JOIN crm_endpoint_claims c ON c.workspace_id=e.workspace_id AND c.endpoint_id=e.id WHERE e.workspace_id=$1 AND e.kind='email' AND e.value_hash=$2 UNION ALL SELECT 1 FROM email_addresses WHERE workspace_id=$1 AND lower(address)=lower($3) LIMIT 1`,
              [input.scope.workspaceId, senderHash, senderEndpoint],
            )
          ).rows.length > 0 || original.matches.length > 0;
        const candidates =
          safeLabel && !knownIdentity
            ? (
                await input.session.query<{ id: string; full_name: string }>(
                  `SELECT DISTINCT p.id,p.full_name FROM crm_mail_source_contexts cx JOIN crm_mail_sources s ON s.workspace_id=cx.workspace_id AND s.source_id=cx.source_id JOIN crm_people p ON p.workspace_id=cx.workspace_id AND p.id=cx.person_id WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.account_binding=$3 AND s.availability='available' AND cx.context_kind='acquired' AND cx.identity_status='observed_label' AND cx.correspondent_endpoint_hash=$4 AND NOT EXISTS(SELECT 1 FROM crm_legacy_contact_people b WHERE b.workspace_id=p.workspace_id AND b.person_id=p.id) ORDER BY p.id LIMIT 2`,
                  [
                    input.scope.workspaceId,
                    staged.authority.proof.ownerUserId,
                    staged.authority.proof.accountBinding,
                    senderHash,
                  ],
                )
              ).rows
            : [];
        if (candidates.length === 1)
          await input.session.query(
            'SELECT id FROM crm_people WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
            [input.scope.workspaceId, candidates[0]!.id],
          );
        let participantDeleted = false;
        const current = await lockCaptureAuthority(
          input,
          payload,
          true,
          async () => {
            // Account locks precede the address barrier, matching metadata observation.
            // Firm/person closure was acquired before either set of locks.
            const captureContext = repositoryContext(
              input.scope,
              input.session,
            );
            const addresses = participants.filter((value) => value !== null);
            await lockBusinessMetadataAddresses(captureContext, addresses);
            for (const address of addresses) {
              const stop = await isSuppressed(captureContext, {
                scope: 'handle',
                canonicalKey: address,
              });
              if (stop?.source === 'deletion_tombstone') {
                participantDeleted = true;
                return false;
              }
            }
            return true;
          },
        );
        if (
          !current ||
          JSON.stringify(current.proof) !==
            JSON.stringify(staged.authority.proof)
        )
          return done(
            participantDeleted ? 'source_deleted' : 'authority_changed',
          );
        const identity = (
          await input.session.query<{
            state: string;
            source_id: string | null;
            job_id: string;
            lease_fencing_token: string;
          }>(
            'SELECT * FROM crm_mail_capture_identities WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
            [input.scope.workspaceId, staged.identityId],
          )
        ).rows[0];
        if (
          !identity ||
          identity.job_id !== input.job.id ||
          identity.lease_fencing_token !== input.job.fencingToken
        )
          return done('capture_fence_lost');
        const recaptureAllowed = await validExplicitMailRecapture(
          input,
          payload,
          staged.identityId,
          current.proof,
        );
        if (
          (payload.recapture && !recaptureAllowed) ||
          identity.state === 'blocked' ||
          ((
            await input.session.query(
              'SELECT 1 FROM crm_mail_acquisition_tombstones WHERE workspace_id=$1 AND capture_identity_id=$2',
              [input.scope.workspaceId, staged.identityId],
            )
          ).rows.length &&
            !recaptureAllowed)
        )
          return done('source_deleted');
        if (identity.state === 'copied' && !recaptureAllowed)
          return done('already_captured', { sourceId: identity.source_id });
        const old = (
          await input.session.query<{ id: string }>(
            'SELECT id FROM mail_messages WHERE workspace_id=$1 AND mailbox_id=$2 AND provider_message_id=$3 FOR UPDATE',
            [
              input.scope.workspaceId,
              payload.mailboxId,
              payload.providerMessageId,
            ],
          )
        ).rows[0];
        if (
          old &&
          (
            await input.session.query(
              'SELECT 1 FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2 AND account_binding<>$3',
              [input.scope.workspaceId, old.id, current.proof.accountBinding],
            )
          ).rows.length
        )
          return done('account_identity_conflict');
        const lockedMatches = await readOriginalMailMatches(
          input,
          old?.id ?? null,
          true,
        );
        if (
          lockedMatches === null ||
          JSON.stringify(lockedMatches) !==
            JSON.stringify(staged.original.matches)
        )
          return done('source_context_changed');
        const outgoing =
          m.labels.includes('SENT') && !m.labels.includes('DRAFT');
        const sourceId =
          old?.id ??
          (
            await input.session.query<{ id: string }>(
              'INSERT INTO mail_messages(workspace_id,id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,header_from,header_to,header_cc,subject,label_ids,business_capture_authorized,metadata_only) VALUES($1,COALESCE($13::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12) RETURNING id',
              [
                input.scope.workspaceId,
                payload.mailboxId,
                m.messageId,
                m.threadId,
                outgoing ? 'outgoing' : 'incoming',
                m.providerAt,
                m.from.toLowerCase(),
                m.to.map((x) => x.toLowerCase()),
                m.cc.map((x) => x.toLowerCase()),
                m.subject,
                m.labels,
                m.body === null,
                payload.recapture?.sourceId ?? null,
              ],
            )
          ).rows[0]!.id;
        const hash = createHash('sha256')
          .update(m.body ?? '')
          .digest('hex');
        if (m.body !== null)
          await input.session.query(
            'INSERT INTO mail_message_bodies(workspace_id,mail_message_id,body_text,truncated) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,mail_message_id) DO NOTHING',
            [
              input.scope.workspaceId,
              sourceId,
              m.body,
              m.completeness !== 'complete',
            ],
          );
        // Never stamp a lineage hash for different original bytes already retained by operational mail.
        const stored = (
          await input.session.query<{ body_text: string }>(
            'SELECT body_text FROM mail_message_bodies WHERE workspace_id=$1 AND mail_message_id=$2',
            [input.scope.workspaceId, sourceId],
          )
        ).rows[0];
        if (
          stored &&
          createHash('sha256').update(stored.body_text).digest('hex') !== hash
        )
          throw new Error('canonical_body_conflict');
        await input.session.query(
          'UPDATE mail_messages SET business_capture_authorized=true,metadata_only=$3 WHERE workspace_id=$1 AND id=$2',
          [input.scope.workspaceId, sourceId, m.body === null],
        );
        const p = current.proof;
        const captureRevision = payload.recapture
          ? payload.recapture.expectedRevision + 1
          : 1;
        const sentProof =
          m.origin === 'sent' &&
          outgoing &&
          m.from === participants[0] &&
          m.from ===
            (
              await input.session.query<Mailbox>(
                'SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2',
                [input.scope.workspaceId, payload.mailboxId],
              )
            ).rows[0]!.email_address &&
          m.to.length > 0 &&
          m.completeness === 'complete' &&
          m.representation === 'plain_text' &&
          m.ranges.some((r) => r.kind === 'authored') &&
          !m.ranges.every((r) => r.kind === 'forwarded' || r.kind === 'quoted');
        await input.session.query(
          `INSERT INTO crm_mail_sources(workspace_id,source_id,capture_identity_id,source_revision,content_hash,owner_user_id,mailbox_id,provider_account_id,account_binding,acquired_generation,controls_revision,policy_revision,conversation_id,decision_revision,disclosure_version,disclosure_sha256,verification_receipts,parser_version,representation,completeness,passage_ranges,participants,raw_sender_date,provider_at,sent_proof) VALUES($1,$2,$3,$25,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20::jsonb,$21::jsonb,$22,$23,$24) ON CONFLICT(workspace_id,source_id) DO UPDATE SET source_revision=EXCLUDED.source_revision,content_hash=EXCLUDED.content_hash,acquired_generation=EXCLUDED.acquired_generation,controls_revision=EXCLUDED.controls_revision,policy_revision=EXCLUDED.policy_revision,decision_revision=EXCLUDED.decision_revision,disclosure_version=EXCLUDED.disclosure_version,disclosure_sha256=EXCLUDED.disclosure_sha256,verification_receipts=EXCLUDED.verification_receipts,parser_version=EXCLUDED.parser_version,representation=EXCLUDED.representation,completeness=EXCLUDED.completeness,passage_ranges=EXCLUDED.passage_ranges,participants=EXCLUDED.participants,raw_sender_date=EXCLUDED.raw_sender_date,provider_at=EXCLUDED.provider_at,sent_proof=EXCLUDED.sent_proof,availability='available',observed_at=now()`,
          [
            input.scope.workspaceId,
            sourceId,
            staged.identityId,
            hash,
            p.ownerUserId,
            p.mailboxId,
            p.providerAccountId,
            p.accountBinding,
            p.generation,
            p.controlsRevision,
            p.policyRevision,
            payload.conversationId,
            payload.decisionRevision,
            p.disclosureVersion,
            p.disclosureSha256,
            JSON.stringify({
              grant: p.grantReceipt,
              providerPolicy: p.providerPolicyReceipt,
              evaluation: p.evaluationReceipt,
              release: p.releaseReceipt,
            }),
            m.parserVersion,
            m.representation,
            m.completeness,
            JSON.stringify(m.ranges),
            JSON.stringify(participants),
            m.rawSenderDate,
            m.providerAt,
            sentProof,
            captureRevision,
          ],
        );
        if (
          safeLabel &&
          !knownIdentity &&
          !m.labels.includes('SENT') &&
          !m.labels.includes('DRAFT') &&
          senderEndpoint !== current.mailboxEmail &&
          candidates.length < 2 &&
          (candidates.length === 0 ||
            candidates[0]!.full_name === observedLabel)
        ) {
          const personId =
            candidates[0]?.id ??
            (
              await input.session.query<{ id: string }>(
                'INSERT INTO crm_people(workspace_id,owner_user_id,full_name) VALUES($1,$2,$3) RETURNING id',
                [
                  input.scope.workspaceId,
                  current.proof.ownerUserId,
                  observedLabel,
                ],
              )
            ).rows[0]!.id;
          await input.session.query(
            "INSERT INTO crm_mail_source_contexts(workspace_id,source_id,source_revision,person_id,context_kind,review,identity_status,correspondent_endpoint_hash,observed_full_name_hash) VALUES($1,$2,$5,$3,'acquired','review_required','observed_label',$4,$6)",
            [
              input.scope.workspaceId,
              sourceId,
              personId,
              senderHash,
              captureRevision,
              createHash('sha256').update(observedLabel!).digest('hex'),
            ],
          );
        }
        if (payload.recapture) {
          await input.session.query(
            `INSERT INTO crm_mail_source_contexts(workspace_id,source_id,source_revision,person_id,firm_id,opportunity_id,context_kind,review,identity_status) SELECT workspace_id,source_id,$3,person_id,firm_id,opportunity_id,'reviewed','review_required','reviewed' FROM crm_mail_source_contexts WHERE workspace_id=$1 AND source_id=$2 AND context_kind='reviewed' AND source_revision=(SELECT max(lastcx.source_revision) FROM crm_mail_source_contexts lastcx WHERE lastcx.workspace_id=$1 AND lastcx.source_id=$2 AND lastcx.context_kind='reviewed' AND lastcx.source_revision<$3)`,
            [input.scope.workspaceId, sourceId, captureRevision],
          );
        }
        for (const match of staged.original.matches) {
          await input.session.query(
            "INSERT INTO crm_mail_source_contexts(workspace_id,source_id,source_revision,firm_id,opportunity_id,context_kind,operational_match_id,operational_match_hash,review) VALUES($1,$2,$8,$3,$4,'acquired',$5,$6,$7)",
            [
              input.scope.workspaceId,
              sourceId,
              match.firmId,
              match.opportunityId,
              match.matchId,
              match.snapshotHash,
              payload.recapture || match.ambiguous
                ? 'review_required'
                : 'current',
              captureRevision,
            ],
          );
        }
        if (staged.original.adminException)
          await recordCrmAuditEvent(
            { scope: input.scope, db: input.session },
            {
              action: 'crm.mail_acquisition_admin_context',
              subjectKind: 'mail_source',
              subjectId: sourceId,
              detail: {
                copyOwnerUserId: p.ownerUserId,
                firmIds: staged.original.matches.map((match) => match.firmId),
              },
            },
          );
        await input.session.query(
          "INSERT INTO crm_mail_source_intents(workspace_id,source_kind,source_id,source_revision,content_hash) VALUES($1,'mail',$2,$4,$3)",
          [input.scope.workspaceId, sourceId, hash, captureRevision],
        );
        await input.session.query(
          "UPDATE crm_mail_capture_identities SET state='copied',source_id=$3 WHERE workspace_id=$1 AND id=$2",
          [input.scope.workspaceId, staged.identityId, sourceId],
        );
        return done('captured', {
          sourceId,
          sourceRevision: captureRevision,
          contentHash: hash,
        });
      });
    },
  };
}

export interface ExactMailSource {
  sourceId: string;
  sourceRevision: number;
  contentHash: string | null;
  locator?: string | undefined;
}
/** Exceptional status is protected by the same append-only audit as copied content. */
async function auditExceptionalMailRead(
  context: RepositoryContext,
  exact: ExactMailSource,
  ownerUserId: string,
  capturedContexts?: readonly MailContext[],
) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || actor.role !== 'admin') return;
  let exceptional = ownerUserId !== actor.userId;
  if (!exceptional) {
    const contexts =
      capturedContexts ?? (await lockMailCopyContext(context, exact.sourceId));
    const firms = [
      ...new Set(
        (contexts ?? []).flatMap((cx) => (cx.firm_id ? [cx.firm_id] : [])),
      ),
    ];
    if (firms.length)
      exceptional =
        (
          await context.db.query(
            'SELECT 1 FROM firms WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND assigned_user_id IS DISTINCT FROM $3::uuid LIMIT 1',
            [context.scope.workspaceId, firms, actor.userId],
          )
        ).rows.length > 0;
  }
  if (exceptional)
    await recordCrmAuditEvent(context, {
      action: 'crm.mail_source_admin_read',
      subjectKind: 'mail_source',
      subjectId: exact.sourceId,
      detail: { sourceRevision: exact.sourceRevision },
    });
}
export async function readMailConversation(
  context: RepositoryContext,
  exact: ExactMailSource,
) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || !(await activeBusinessActor(context)))
    return {
      state: 'unavailable',
      reason: 'source_unknown',
      source: null,
    } as const;
  const known = (
    await context.db.query<{ owner_user_id: string; availability: string }>(
      'SELECT t.owner_user_id,t.availability FROM crm_mail_acquisition_tombstones t WHERE t.workspace_id=$1 AND t.source_id=$2 AND (t.source_revision >= $3 OR t.source_revision >= COALESCE((SELECT source_revision FROM crm_mail_sources s WHERE s.workspace_id=t.workspace_id AND s.source_id=t.source_id),0)) ORDER BY t.source_revision DESC LIMIT 1',
      [context.scope.workspaceId, exact.sourceId, exact.sourceRevision],
    )
  ).rows[0];
  if (
    known &&
    (actor.role === 'admin' || known.owner_user_id === actor.userId)
  ) {
    await auditExceptionalMailRead(context, exact, known.owner_user_id);
    return {
      state: 'unavailable',
      reason: known.availability,
      source: null,
    } as const;
  }
  const lineage = await context.db.query(
    'SELECT 1 FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2',
    [context.scope.workspaceId, exact.sourceId],
  );
  if (!lineage.rows.length) {
    const legacy = await context.db.query<{ owner_user_id: string }>(
      'SELECT mb.owner_user_id FROM mail_messages m JOIN mailboxes mb ON mb.workspace_id=m.workspace_id AND mb.id=m.mailbox_id WHERE m.workspace_id=$1 AND m.id=$2 AND ($3::boolean OR mb.owner_user_id=$4)',
      [
        context.scope.workspaceId,
        exact.sourceId,
        actor.role === 'admin',
        actor.userId,
      ],
    );
    if (legacy.rows[0])
      await auditExceptionalMailRead(
        context,
        exact,
        legacy.rows[0].owner_user_id,
        [],
      );
    return {
      state: 'unavailable',
      reason: legacy.rows.length ? 'provenance_unavailable' : 'source_unknown',
      source: null,
    } as const;
  }
  const copyContext = await lockMailCopyContext(context, exact.sourceId);
  if (copyContext === null)
    return {
      state: 'unavailable',
      reason: 'source_unknown',
      source: null,
    } as const;
  const row = (
    await context.db.query<
      Control & {
        source_id: string;
        direction: 'incoming' | 'outgoing';
        subject: string | null;
        mailbox_id: string;
        source_revision: number;
        content_hash: string;
        availability: string;
        body_text: string | null;
        provider_at: Date;
        observed_at: Date;
        acquired_generation: number;
        participants: string[];
        passage_ranges: unknown;
        parser_version: string;
        representation: string;
        completeness: string;
        raw_sender_date: string | null;
        sent_proof: boolean;
      }
    >(
      `SELECT s.*,m.direction,m.subject,b.body_text FROM crm_mail_sources s JOIN mail_messages m ON m.workspace_id=s.workspace_id AND m.id=s.source_id LEFT JOIN mail_message_bodies b ON b.workspace_id=s.workspace_id AND b.mail_message_id=s.source_id WHERE s.workspace_id=$1 AND s.source_id=$2 FOR UPDATE OF s`,
      [context.scope.workspaceId, exact.sourceId],
    )
  ).rows[0];
  if (!row || (actor.role !== 'admin' && row.owner_user_id !== actor.userId))
    return {
      state: 'unavailable',
      reason: 'source_unknown',
      source: null,
    } as const;
  if (!(await activeBusinessActor(context)))
    return {
      state: 'unavailable',
      reason: 'source_unknown',
      source: null,
    } as const;
  await auditExceptionalMailRead(
    context,
    exact,
    row.owner_user_id,
    copyContext,
  );

  if (row.availability !== 'available')
    return {
      state: 'unavailable',
      reason: row.availability,
      source: null,
    } as const;
  if (
    row.source_revision !== exact.sourceRevision ||
    row.content_hash !== exact.contentHash ||
    (row.body_text !== null &&
      createHash('sha256').update(row.body_text).digest('hex') !==
        row.content_hash)
  )
    return {
      state: 'unavailable',
      reason: 'source_changed',
      source: null,
    } as const;
  if (!(await activeBusinessActor(context)))
    return {
      state: 'unavailable',
      reason: 'source_unknown',
      source: null,
    } as const;

  return {
    state: 'available',
    source: {
      sourceId: row.source_id,
      direction: row.direction,
      subject: row.subject,
      sourceRevision: row.source_revision,
      contentHash: row.content_hash,
      passage: row.body_text,
      ownerUserId: row.owner_user_id,
      mailboxId: row.mailbox_id,
      accountBinding: row.account_binding,
      acquiredGeneration: row.acquired_generation,
      originalContexts: copyContext
        .filter((cx) => cx.context_kind === 'acquired')
        .map(contextDto),
      reviewedContexts: copyContext
        .filter((cx) => cx.context_kind === 'reviewed')
        .map(contextDto),
      participants: row.participants,
      parserVersion: row.parser_version,
      representation: row.representation,
      completeness: row.completeness,
      rawSenderDate: row.raw_sender_date,
      occurredAt: row.provider_at.toISOString(),
      observedAt: row.observed_at.toISOString(),
      ranges: row.passage_ranges,
      sentProof: row.sent_proof,
    },
  } as const;
}

/** Body-free state remains authoritative after a canonical-message cascade. */
export async function readMailSourceState(
  context: RepositoryContext,
  input: { sourceId: string },
) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || !(await activeBusinessActor(context)))
    return null;
  const tombstone = (
    await context.db.query<{
      owner_user_id: string;
      source_revision: number;
      availability: string;
    }>(
      'SELECT t.owner_user_id,t.source_revision,t.availability FROM crm_mail_acquisition_tombstones t WHERE t.workspace_id=$1 AND t.source_id=$2 AND t.source_revision >= COALESCE((SELECT source_revision FROM crm_mail_sources s WHERE s.workspace_id=t.workspace_id AND s.source_id=t.source_id),0) ORDER BY t.source_revision DESC LIMIT 1 FOR UPDATE',
      [context.scope.workspaceId, input.sourceId],
    )
  ).rows[0];
  if (tombstone) {
    if (actor.role !== 'admin' && tombstone.owner_user_id !== actor.userId)
      return null;
    if (!(await activeBusinessActor(context))) return null;
    if (actor.role === 'admin' && tombstone.owner_user_id !== actor.userId)
      await recordCrmAuditEvent(context, {
        action: 'crm.mail_source_admin_state_read',
        subjectKind: 'mail_source',
        subjectId: input.sourceId,
        detail: { sourceRevision: tombstone.source_revision },
      });
    return {
      revision: tombstone.source_revision,
      availability: tombstone.availability,
    };
  }
  if ((await lockMailCopyContext(context, input.sourceId)) === null)
    return null;
  const current = (
    await context.db.query<{
      owner_user_id: string;
      source_revision: number;
      availability: string;
    }>(
      'SELECT owner_user_id,source_revision,availability FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2',
      [context.scope.workspaceId, input.sourceId],
    )
  ).rows[0];
  if (!current || !(await activeBusinessActor(context))) return null;
  if (actor.role === 'admin' && current.owner_user_id !== actor.userId)
    await recordCrmAuditEvent(context, {
      action: 'crm.mail_source_admin_state_read',
      subjectKind: 'mail_source',
      subjectId: input.sourceId,
      detail: { sourceRevision: current.source_revision },
    });
  return {
    revision: current.source_revision,
    availability: current.availability,
  };
}

export async function readMailCaptureControls(
  context: RepositoryContext,
  mailboxId?: string,
) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || !(await activeBusinessActor(context)))
    return null;
  const mailbox = (
    await context.db.query<Mailbox>(
      `SELECT * FROM mailboxes WHERE workspace_id=$1 AND ${mailboxId === undefined ? 'owner_user_id=$2' : 'id=$2'} FOR NO KEY UPDATE`,
      [context.scope.workspaceId, mailboxId ?? actor.userId],
    )
  ).rows[0];
  if (
    !mailbox ||
    (actor.role !== 'admin' && mailbox.owner_user_id !== actor.userId)
  )
    return null;
  const control = (
    await context.db.query<Control>(
      'SELECT * FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2',
      [context.scope.workspaceId, mailbox.id],
    )
  ).rows[0];
  if (!(await activeBusinessActor(context))) return null;
  const enabled = control?.enabled === true;
  const reason =
    mailbox.status !== 'connected'
      ? 'mailbox_disconnected'
      : mailbox.provider_account_id === null
        ? 'account_identity_unproven'
        : !enabled
          ? 'acquisition_disabled'
          : control.generation !== mailbox.generation ||
              control.account_binding !==
                businessAccountBinding(context.scope.workspaceId, mailbox)
            ? 'binding_changed'
            : 'activation_not_available';
  return {
    mailboxId: mailbox.id,
    enabled,
    ready: false,
    reason,
    revision: control?.revision ?? 0,
  };
}

export async function changeMailSource(
  context: RepositoryContext,
  input: { sourceId: string; expectedRevision: number },
  action: 'delete' | 'restore',
) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || !(await activeBusinessActor(context)))
    return { ok: false as const, reason: 'source_access_denied' };
  if ((await lockMailCopyContext(context, input.sourceId)) === null)
    return { ok: false as const, reason: 'source_access_denied' };
  const source = (
    await context.db.query<{
      source_id: string;
      source_revision: number;
      content_hash: string;
      owner_user_id: string;
      capture_identity_id: string;
      availability: string;
    }>(
      'SELECT * FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2 FOR UPDATE',
      [context.scope.workspaceId, input.sourceId],
    )
  ).rows[0];
  if (
    !source ||
    (actor.role !== 'admin' && source.owner_user_id !== actor.userId) ||
    !(await activeBusinessActor(context))
  )
    return { ok: false as const, reason: 'source_access_denied' };
  if (source.source_revision !== input.expectedRevision)
    return { ok: false as const, reason: 'source_changed' };
  if (action === 'restore' && source.availability !== 'deleted')
    return { ok: false as const, reason: 'source_changed' };
  const revision = source.source_revision + 1;
  const availability = action === 'delete' ? 'deleted' : 'awaiting_recapture';
  if (action === 'delete') {
    await context.db.query(
      'DELETE FROM mail_message_bodies WHERE workspace_id=$1 AND mail_message_id=$2',
      [context.scope.workspaceId, input.sourceId],
    );
    await context.db.query(
      "UPDATE mail_messages SET metadata_only=true,header_from=NULL,header_to='{}',header_cc='{}',subject=NULL,reference_message_ids='{}',in_reply_to=NULL,auto_submitted=NULL,list_id=NULL,label_ids='{}',attachment_references='[]' WHERE workspace_id=$1 AND id=$2",
      [context.scope.workspaceId, input.sourceId],
    );
    await context.db.query(
      "UPDATE crm_mail_sources SET participants='[]',raw_sender_date=NULL,passage_ranges='[]',sent_proof=false,provider_at=NULL,observed_at=NULL,availability=$3,source_revision=$4 WHERE workspace_id=$1 AND source_id=$2",
      [context.scope.workspaceId, input.sourceId, availability, revision],
    );
    await context.db.query(
      `DELETE FROM mail_messages m WHERE m.workspace_id=$1 AND m.id=$2 AND NOT m.matched AND NOT EXISTS(SELECT 1 FROM mail_message_matches mx WHERE mx.workspace_id=m.workspace_id AND mx.mail_message_id=m.id)`,
      [context.scope.workspaceId, input.sourceId],
    );
    await context.db.query(
      "UPDATE crm_mail_source_contexts SET review='review_required' WHERE workspace_id=$1 AND source_id=$2",
      [context.scope.workspaceId, input.sourceId],
    );
    await context.db.query(
      "UPDATE crm_mail_source_intents SET state='invalidated' WHERE workspace_id=$1 AND source_id=$2",
      [context.scope.workspaceId, input.sourceId],
    );
  }
  await context.db.query(
    'UPDATE crm_mail_sources SET availability=$3,source_revision=$4 WHERE workspace_id=$1 AND source_id=$2',
    [context.scope.workspaceId, input.sourceId, availability, revision],
  );
  await context.db.query(
    'INSERT INTO crm_mail_acquisition_tombstones(workspace_id,capture_identity_id,source_id,owner_user_id,source_revision,content_hash,availability) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,source_id,source_revision) DO NOTHING',
    [
      context.scope.workspaceId,
      source.capture_identity_id,
      input.sourceId,
      source.owner_user_id,
      revision,
      source.content_hash,
      availability,
    ],
  );
  if (action === 'delete')
    await redactUnsupportedObservedMailLabels(context, [input.sourceId]);
  await recordCrmAuditEvent(context, {
    action:
      action === 'delete' ? 'crm.mail_copy_deleted' : 'crm.mail_copy_restored',
    subjectKind: 'mail_source',
    subjectId: input.sourceId,
    detail: { sourceRevision: revision },
  });
  return {
    ok: true as const,
    value: { sourceId: input.sourceId, sourceRevision: revision, availability },
  };
}

/** Retire only an unchanged label derived solely from removed mail copies.
 * Caller holds the complete affected person/context closure. Body-free hashes
 * prevent a later human name correction from being overwritten. */
export async function eligibleObservedMailLabelRedactions(
  context: RepositoryContext,
  removedSourceIds: readonly string[],
) {
  const eligible: string[] = [];
  const candidates = (
    await context.db.query<{
      person_id: string;
      full_name: string;
      observed_full_name_hash: string;
    }>(
      `SELECT DISTINCT p.id AS person_id,p.full_name,cx.observed_full_name_hash FROM crm_mail_source_contexts cx JOIN crm_people p ON p.workspace_id=cx.workspace_id AND p.id=cx.person_id WHERE cx.workspace_id=$1 AND cx.source_id=ANY($2::uuid[]) AND cx.context_kind='acquired' AND cx.identity_status='observed_label' ORDER BY p.id`,
      [context.scope.workspaceId, removedSourceIds],
    )
  ).rows;
  for (const candidate of candidates) {
    if (
      createHash('sha256').update(candidate.full_name).digest('hex') !==
      candidate.observed_full_name_hash
    )
      continue;
    const retained = (
      await context.db.query(
        `SELECT 1 FROM crm_mail_source_contexts cx JOIN crm_mail_sources s ON s.workspace_id=cx.workspace_id AND s.source_id=cx.source_id WHERE cx.workspace_id=$1 AND cx.person_id=$2 AND s.availability='available' AND ${mailContextPredicate()} AND NOT(s.source_id=ANY($3::uuid[])) AND (cx.context_kind='reviewed' OR cx.observed_full_name_hash=$4) UNION ALL SELECT 1 FROM crm_selected_sources WHERE workspace_id=$1 AND person_id=$2 AND availability='available' UNION ALL SELECT 1 FROM crm_legacy_contact_people WHERE workspace_id=$1 AND person_id=$2 LIMIT 1`,
        [
          context.scope.workspaceId,
          candidate.person_id,
          removedSourceIds,
          candidate.observed_full_name_hash,
        ],
      )
    ).rows.length;
    if (retained) continue;
    eligible.push(candidate.person_id);
  }
  return [...new Set(eligible)].sort();
}

export async function redactUnsupportedObservedMailLabels(
  context: RepositoryContext,
  removedSourceIds: readonly string[],
) {
  const ids = await eligibleObservedMailLabelRedactions(
    context,
    removedSourceIds,
  );
  const result = await context.db.query(
    "UPDATE crm_people SET full_name='[unknown]',revision=revision+1 WHERE workspace_id=$1 AND id=ANY($2::uuid[]) RETURNING id",
    [context.scope.workspaceId, ids],
  );
  return result.rows.length;
}

/** An explicit restore request queues metadata-only work; only the worker's
 * separate exact proof verifier can grant the later provider body read. */
export async function requestMailRecapture(
  context: RepositoryContext,
  input: { sourceId: string; expectedRevision: number },
) {
  const actor = context.scope.actor;
  if (
    actor.kind !== 'user' ||
    (await lockMailCopyContext(context, input.sourceId, {
      deferCopyLocks: true,
    })) === null
  )
    return { ok: false as const, reason: 'source_access_denied' };
  const row = (
    await context.db.query<{
      mailbox_id: string;
      source_revision: number;
      owner_user_id: string;
      account_binding: string;
      availability: string;
      conversation_id: string;
      provider_message_id: string;
    }>(
      'SELECT s.*,i.provider_message_id FROM crm_mail_sources s JOIN crm_mail_capture_identities i ON i.workspace_id=s.workspace_id AND i.id=s.capture_identity_id WHERE s.workspace_id=$1 AND s.source_id=$2',
      [context.scope.workspaceId, input.sourceId],
    )
  ).rows[0];
  if (
    !row ||
    row.source_revision !== input.expectedRevision ||
    row.availability !== 'awaiting_recapture'
  )
    return { ok: false as const, reason: 'source_changed' };
  const mailbox = (
    await context.db.query<Mailbox>(
      'SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE',
      [context.scope.workspaceId, row.mailbox_id],
    )
  ).rows[0];
  const control = (
    await context.db.query<Control>(
      'SELECT * FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2 FOR UPDATE',
      [context.scope.workspaceId, row.mailbox_id],
    )
  ).rows[0];
  if (
    !mailbox ||
    mailbox.status !== 'connected' ||
    mailbox.owner_user_id !== row.owner_user_id ||
    businessAccountBinding(context.scope.workspaceId, mailbox) !==
      row.account_binding ||
    !control?.enabled ||
    control.generation !== mailbox.generation ||
    control.account_binding !== row.account_binding
  )
    return { ok: false as const, reason: 'acquisition_disabled' };
  const conversation = (
    await context.db.query<Conversation>(
      'SELECT * FROM crm_business_conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [context.scope.workspaceId, row.conversation_id],
    )
  ).rows[0];
  if (
    !conversation ||
    conversation.metadata_availability !== 'available' ||
    !(
      conversation.human_decision === 'include' ||
      (conversation.human_decision === null &&
        conversation.category === 'business')
    ) ||
    !(await activeBusinessActor(context))
  )
    return { ok: false as const, reason: 'source_access_denied' };
  await context.db.query(
    'SELECT i.id FROM crm_mail_capture_identities i JOIN crm_mail_sources s ON s.workspace_id=i.workspace_id AND s.capture_identity_id=i.id WHERE s.workspace_id=$1 AND s.source_id=$2 FOR UPDATE OF i',
    [context.scope.workspaceId, input.sourceId],
  );
  await context.db.query(
    'SELECT id FROM mail_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
    [context.scope.workspaceId, input.sourceId],
  );
  const after = (
    await context.db.query<{ source_revision: number; availability: string }>(
      'SELECT source_revision,availability FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2 FOR UPDATE',
      [context.scope.workspaceId, input.sourceId],
    )
  ).rows[0];
  if (
    !after ||
    after.source_revision !== input.expectedRevision ||
    after.availability !== 'awaiting_recapture' ||
    !(await activeBusinessActor(context))
  )
    return { ok: false as const, reason: 'source_changed' };
  await enqueueJob(context.db, {
    workspaceId: context.scope.workspaceId,
    kind: 'crm.mail_capture',
    idempotencyKey: `mail-recapture:${createHash('sha256')
      .update(
        JSON.stringify({
          sourceId: input.sourceId,
          revision: input.expectedRevision,
          generation: mailbox.generation,
          controlsRevision: control.revision,
          policyRevision: control.policy_revision,
          decisionRevision: conversation.decision_revision,
        }),
      )
      .digest('hex')}`,
    payload: {
      mailboxId: mailbox.id,
      providerMessageId: row.provider_message_id,
      providerAccountId: mailbox.provider_account_id,
      generation: mailbox.generation,
      conversationId: row.conversation_id,
      controlsRevision: control.revision,
      policyRevision: control.policy_revision,
      decisionRevision: conversation.decision_revision,
      recapture: {
        sourceId: input.sourceId,
        expectedRevision: input.expectedRevision,
      },
    },
  });
  return {
    ok: true as const,
    value: {
      sourceId: input.sourceId,
      sourceRevision: input.expectedRevision,
      status: 'queued' as const,
    },
  };
}

/** Canonical evidence is a bounded exact range; the product conversation read is separate. */
export async function resolveMailSource(
  context: RepositoryContext,
  exact: ExactMailSource,
) {
  const read = await readMailConversation(context, exact);
  if (read.state !== 'available') return read;
  const body = read.source.passage;
  if (body === null)
    return {
      state: 'unavailable',
      reason: 'body_unavailable',
      source: null,
    } as const;
  const range = exact.locator?.match(/^text:(\d+):(\d+)$/u);
  if (exact.locator !== undefined && !range)
    return {
      state: 'unavailable',
      reason: 'locator_invalid',
      source: null,
    } as const;
  const start = range ? Number(range[1]) : 0;
  let end = range ? Number(range[2]) : Math.min(body.length, 2000);
  if (
    !range &&
    end < body.length &&
    end > 0 &&
    /[\uD800-\uDBFF]/u.test(body[end - 1]!)
  )
    end--;
  if (
    start < 0 ||
    end <= start ||
    end > body.length ||
    end - start > 2000 ||
    (start > 0 && /[\uDC00-\uDFFF]/u.test(body[start]!)) ||
    (end < body.length && /[\uD800-\uDBFF]/u.test(body[end - 1]!))
  )
    return {
      state: 'unavailable',
      reason: 'locator_invalid',
      source: null,
    } as const;
  return {
    ...read,
    source: {
      ...read.source,
      passage: body.slice(start, end),
      locator: `text:${start}:${end}`,
    },
  };
}

export async function listMailSources(
  context: RepositoryContext,
  input: {
    mailboxId?: string | undefined;
    personId?: string | undefined;
    firmId?: string | undefined;
    afterId?: string | undefined;
    limit: number;
  },
) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || !(await activeBusinessActor(context)))
    return { sources: [], nextAfterId: null };
  const rows = (
    await context.db.query<{
      source_id: string;
      source_revision: number;
      content_hash: string;
      availability: string;
      provider_at: Date | null;
      completeness: string;
      mailbox_id: string;
      conversation_id: string;
    }>(
      `SELECT s.source_id,s.source_revision,s.content_hash,s.availability,s.provider_at,s.completeness,s.mailbox_id,s.conversation_id FROM crm_mail_sources s WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND ($3::uuid IS NULL OR s.mailbox_id=$3) AND ($4::uuid IS NULL OR s.source_id>$4) AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM crm_mail_source_contexts cx WHERE cx.workspace_id=s.workspace_id AND cx.source_id=s.source_id AND ${mailContextPredicate()} AND cx.person_id=$5)) AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM crm_mail_source_contexts cx WHERE cx.workspace_id=s.workspace_id AND cx.source_id=s.source_id AND ${mailContextPredicate()} AND cx.firm_id=$6)) AND ($8::boolean OR NOT EXISTS(SELECT 1 FROM crm_mail_source_contexts ac JOIN firms af ON af.workspace_id=ac.workspace_id AND af.id=ac.firm_id WHERE ac.workspace_id=s.workspace_id AND ac.source_id=s.source_id AND ${mailContextPredicate('s', 'ac')} AND (af.status<>'active' OR af.assigned_user_id IS DISTINCT FROM $2))) ORDER BY s.source_id LIMIT $7`,
      [
        context.scope.workspaceId,
        actor.userId,
        input.mailboxId ?? null,
        input.afterId ?? null,
        input.personId ?? null,
        input.firmId ?? null,
        input.limit + 1,
        actor.role === 'admin',
      ],
    )
  ).rows;
  const sourceIds = rows.map((row) => row.source_id).sort();
  const readContexts = async () =>
    (
      await context.db.query<MailContext>(
        `SELECT cx.* FROM crm_mail_source_contexts cx JOIN crm_mail_sources s ON s.workspace_id=cx.workspace_id AND s.source_id=cx.source_id WHERE s.workspace_id=$1 AND s.source_id=ANY($2::uuid[]) AND ${mailContextPredicate()} ORDER BY cx.id LIMIT $3`,
        [context.scope.workspaceId, sourceIds, (input.limit + 1) * 100 + 1],
      )
    ).rows;
  const initialContexts = await readContexts();
  if (initialContexts.length > (input.limit + 1) * 100)
    return { sources: [], nextAfterId: null };
  if (
    !(await lockIdentityContext(context, {
      firmIds: [
        ...new Set(
          initialContexts.flatMap((cx) => (cx.firm_id ? [cx.firm_id] : [])),
        ),
      ].sort(),
      personIds: [
        ...new Set(
          initialContexts.flatMap((cx) => (cx.person_id ? [cx.person_id] : [])),
        ),
      ].sort(),
    }))
  )
    return { sources: [], nextAfterId: null };
  await lockMailGrantRows(
    context,
    rows.map((row) => row.mailbox_id),
    rows.map((row) => row.conversation_id),
  );
  const locked = (
    await context.db.query<{
      source_id: string;
      source_revision: number;
      content_hash: string;
      owner_user_id: string;
    }>(
      'SELECT source_id,source_revision,content_hash,owner_user_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=ANY($2::uuid[]) ORDER BY source_id FOR UPDATE',
      [context.scope.workspaceId, sourceIds],
    )
  ).rows;
  if (
    locked.length !== rows.length ||
    locked.some((row) => {
      const initial = rows.find(
        (candidate) => candidate.source_id === row.source_id,
      );
      return (
        !initial ||
        initial.source_revision !== row.source_revision ||
        initial.content_hash !== row.content_hash ||
        row.owner_user_id !== actor.userId
      );
    }) ||
    JSON.stringify(await readContexts()) !== JSON.stringify(initialContexts) ||
    !(await activeBusinessActor(context))
  )
    return { sources: [], nextAfterId: null };
  return {
    sources: rows.slice(0, input.limit).map((row) => ({
      sourceId: row.source_id,
      sourceRevision: row.source_revision,
      contentHash: row.content_hash,
      availability: row.availability,
      occurredAt: row.provider_at?.toISOString() ?? null,
      completeness: row.completeness,
    })),
    nextAfterId:
      rows.length > input.limit ? rows[input.limit - 1]!.source_id : null,
  };
}

/** Last explicit reviewed snapshot governs unavailable copies as well. */
export function mailContextPredicate(sourceAlias = 's', contextAlias = 'cx') {
  return `(${contextAlias}.context_kind='acquired' OR ${contextAlias}.source_revision=CASE WHEN ${sourceAlias}.availability='available' THEN ${sourceAlias}.source_revision ELSE (SELECT max(lastcx.source_revision) FROM crm_mail_source_contexts lastcx WHERE lastcx.workspace_id=${sourceAlias}.workspace_id AND lastcx.source_id=${sourceAlias}.source_id AND lastcx.context_kind='reviewed' AND lastcx.source_revision<=${sourceAlias}.source_revision) END)`;
}

interface MailContext extends Record<string, unknown> {
  id: string;
  source_id: string;
  source_revision: number;
  person_id: string | null;
  firm_id: string | null;
  opportunity_id: string | null;
  context_kind: string;
  review: string;
  operational_match_id: string | null;
  operational_match_hash: string | null;
  identity_status: string;
  correspondent_endpoint_hash: string | null;
  observed_full_name_hash: string | null;
}
const contextDto = (cx: MailContext) => ({
  contextId: cx.id,
  personId: cx.person_id,
  firmId: cx.firm_id,
  opportunityId: cx.opportunity_id,
  sourceRevision: cx.source_revision,
  review: cx.review,
  operationalMatchId: cx.operational_match_id,
  operationalMatchHash: cx.operational_match_hash,
  identityStatus: cx.identity_status,
});
/** All grant rows precede every copy lock. Locking is not processing consent:
 * retained history remains readable when disconnected or controls are disabled. */
async function lockMailGrantRows(
  context: RepositoryContext,
  mailboxIds: readonly string[],
  conversationIds: readonly string[],
) {
  const mailboxes = [...new Set(mailboxIds)].sort();
  const conversations = [...new Set(conversationIds)].sort();
  await context.db.query(
    'SELECT id FROM mailboxes WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
    [context.scope.workspaceId, mailboxes],
  );
  await context.db.query(
    'SELECT mailbox_id FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=ANY($2::uuid[]) ORDER BY mailbox_id FOR SHARE',
    [context.scope.workspaceId, mailboxes],
  );
  await context.db.query(
    'SELECT mailbox_id FROM crm_business_policies WHERE workspace_id=$1 AND mailbox_id=ANY($2::uuid[]) ORDER BY mailbox_id FOR SHARE',
    [context.scope.workspaceId, mailboxes],
  );
  await context.db.query(
    'SELECT id FROM crm_business_conversations WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
    [context.scope.workspaceId, conversations],
  );
}

/** Acquire complete original/current reviewed context closure before the mail source lock. */
async function lockMailCopyContext(
  context: RepositoryContext,
  sourceId: string,
  additional: {
    personIds?: string[];
    firmIds?: string[];
    deferCopyLocks?: boolean;
  } = {},
) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || !(await activeBusinessActor(context)))
    return null;
  const initial = (
    await context.db.query<{
      owner_user_id: string;
      source_revision: number;
      capture_identity_id: string;
      mailbox_id: string;
      conversation_id: string;
    }>(
      'SELECT owner_user_id,source_revision,capture_identity_id,mailbox_id,conversation_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2',
      [context.scope.workspaceId, sourceId],
    )
  ).rows[0];
  if (
    !initial ||
    (actor.role !== 'admin' && initial.owner_user_id !== actor.userId)
  )
    return null;
  const contexts = (
    await context.db.query<MailContext>(
      `SELECT cx.* FROM crm_mail_source_contexts cx JOIN crm_mail_sources s ON s.workspace_id=cx.workspace_id AND s.source_id=cx.source_id WHERE s.workspace_id=$1 AND s.source_id=$2 AND s.source_revision=$3 AND ${mailContextPredicate()} ORDER BY cx.id LIMIT 101`,
      [context.scope.workspaceId, sourceId, initial.source_revision],
    )
  ).rows;
  if (contexts.length > 100) return null;
  const firms = [
    ...new Set([
      ...contexts.flatMap((cx) => (cx.firm_id ? [cx.firm_id] : [])),
      ...(additional.firmIds ?? []),
    ]),
  ].sort();
  const people = [
    ...new Set([
      ...contexts.flatMap((cx) => (cx.person_id ? [cx.person_id] : [])),
      ...(additional.personIds ?? []),
    ]),
  ].sort();
  if (
    !(await lockIdentityContext(context, { firmIds: firms, personIds: people }))
  )
    return null;
  if (!additional.deferCopyLocks) {
    await lockMailGrantRows(
      context,
      [initial.mailbox_id],
      [initial.conversation_id],
    );
    await context.db.query(
      'SELECT id FROM crm_mail_capture_identities WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [context.scope.workspaceId, initial.capture_identity_id],
    );
    await context.db.query(
      'SELECT id FROM mail_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [context.scope.workspaceId, sourceId],
    );
  }
  const current = (
    await context.db.query<{ owner_user_id: string; source_revision: number }>(
      `SELECT owner_user_id,source_revision FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2 ${additional.deferCopyLocks ? '' : 'FOR UPDATE'}`,
      [context.scope.workspaceId, sourceId],
    )
  ).rows[0];
  if (
    !current ||
    current.source_revision !== initial.source_revision ||
    current.owner_user_id !== initial.owner_user_id
  )
    return null;
  const after = (
    await context.db.query<MailContext>(
      `SELECT cx.* FROM crm_mail_source_contexts cx JOIN crm_mail_sources s ON s.workspace_id=cx.workspace_id AND s.source_id=cx.source_id WHERE s.workspace_id=$1 AND s.source_id=$2 AND s.source_revision=$3 AND ${mailContextPredicate()} ORDER BY cx.id LIMIT 101`,
      [context.scope.workspaceId, sourceId, current.source_revision],
    )
  ).rows;
  if (
    JSON.stringify(after) !== JSON.stringify(contexts) ||
    !(await activeBusinessActor(context))
  )
    return null;
  return after;
}
export async function associateMailSource(
  context: RepositoryContext,
  input: {
    sourceId: string;
    expectedRevision: number;
    personId?: string | undefined;
    firmId?: string | undefined;
  },
) {
  const contexts = await lockMailCopyContext(context, input.sourceId, {
    personIds: input.personId ? [input.personId] : [],
    firmIds: input.firmId ? [input.firmId] : [],
  });
  if (contexts === null)
    return { ok: false as const, reason: 'source_access_denied' };
  const source = (
    await context.db.query<{
      source_revision: number;
      content_hash: string;
      availability: string;
    }>(
      'SELECT source_revision,content_hash,availability FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2',
      [context.scope.workspaceId, input.sourceId],
    )
  ).rows[0]!;
  if (
    source.source_revision !== input.expectedRevision ||
    source.availability !== 'available'
  )
    return { ok: false as const, reason: 'source_changed' };
  const revision = source.source_revision + 1;
  await context.db.query(
    "INSERT INTO crm_mail_source_contexts(workspace_id,source_id,source_revision,person_id,firm_id,context_kind) VALUES($1,$2,$3,$4,$5,'reviewed')",
    [
      context.scope.workspaceId,
      input.sourceId,
      revision,
      input.personId ?? null,
      input.firmId ?? null,
    ],
  );
  await context.db.query(
    'UPDATE crm_mail_sources SET source_revision=$3 WHERE workspace_id=$1 AND source_id=$2',
    [context.scope.workspaceId, input.sourceId, revision],
  );
  await context.db.query(
    "UPDATE crm_mail_source_intents SET state='invalidated' WHERE workspace_id=$1 AND source_id=$2",
    [context.scope.workspaceId, input.sourceId],
  );
  await context.db.query(
    "INSERT INTO crm_mail_source_intents(workspace_id,source_kind,source_id,source_revision,content_hash) VALUES($1,'mail',$2,$3,$4)",
    [context.scope.workspaceId, input.sourceId, revision, source.content_hash],
  );
  await recordCrmAuditEvent(context, {
    action: 'crm.mail_source_associated',
    subjectKind: 'mail_source',
    subjectId: input.sourceId,
    detail: {
      sourceRevision: revision,
      personId: input.personId ?? null,
      firmId: input.firmId ?? null,
    },
  });
  return {
    ok: true as const,
    value: { sourceId: input.sourceId, sourceRevision: revision },
  };
}

export interface CapturedMailProcessingAuthority {
  exact: ExactMailSource;
  purposeOwner: string;
  proof: MailCaptureProof;
  conversationId: string;
  decisionRevision: number;
  acquiredGeneration: number;
  authorizationFingerprint: string;
}
/** DB-only locked snapshot. A separately verified token is required for paid work. */
export async function prepareMailProcessingAuthority(
  context: RepositoryContext,
  exact: ExactMailSource,
  purposeOwner: string,
) {
  return prepareMailProcessingSnapshot(context, exact, purposeOwner, true);
}
/** Nonlocking scheduler hint: no body, verifier or retained per-source locks.
 * A worker must verify externally and then lock/revalidate the entire exact copy. */
export async function snapshotMailProcessingAuthority(
  context: RepositoryContext,
  exact: ExactMailSource,
  purposeOwner: string,
) {
  return prepareMailProcessingSnapshot(context, exact, purposeOwner, false);
}
/** Nonlocking, body-free exact context hint. Never processing authorization. */
export async function snapshotMailProcessingSourceContexts(context:RepositoryContext,exact:ExactMailSource,purposeOwner:string){
 const before=await snapshotMailProcessingAuthority(context,exact,purposeOwner);
 if(!before.ok)return before;
 const rows=(await context.db.query<MailContext>(`SELECT cx.* FROM crm_mail_source_contexts cx JOIN crm_mail_sources s ON s.workspace_id=cx.workspace_id AND s.source_id=cx.source_id WHERE s.workspace_id=$1 AND s.source_id=$2 AND s.source_revision=$3 AND s.content_hash=$4 AND ${mailContextPredicate()} ORDER BY cx.id LIMIT 101`,[context.scope.workspaceId,exact.sourceId,exact.sourceRevision,exact.contentHash])).rows;
 if(rows.length>100)return {ok:false as const,reason:'context_limit'};
 const after=await snapshotMailProcessingAuthority(context,exact,purposeOwner);
 if(!after.ok||after.authority.authorizationFingerprint!==before.authority.authorizationFingerprint)return {ok:false as const,reason:'source_changed'};
 return {ok:true as const,authority:after.authority,contexts:rows.map(cx=>({...contextDto(cx),contextKind:cx.context_kind}))};
}
async function prepareMailProcessingSnapshot(
  context: RepositoryContext,
  exact: ExactMailSource,
  purposeOwner: string,
  lock: boolean,
): Promise<
  | { ok: true; authority: CapturedMailProcessingAuthority }
  | { ok: false; reason: string }
> {
  const actor = context.scope.actor;
  if (
    actor.kind !== 'user' ||
    actor.userId !== purposeOwner ||
    !(await activeBusinessActor(context))
  )
    return { ok: false, reason: 'processing_authority_unavailable' };
  if (lock) {
    if (!(await lockMailCopyContext(context, exact.sourceId)))
      return { ok: false, reason: 'source_unknown' };
  } else {
    // This unverified scheduler hint never bypasses the immutable owner or the
    // current firm scope. Concurrent changes are refused by worker revalidation.
    const visible = await context.db.query(
      `SELECT 1 FROM crm_mail_sources s WHERE s.workspace_id=$1 AND s.source_id=$2 AND s.owner_user_id=$3
       AND NOT EXISTS(SELECT 1 FROM crm_mail_source_contexts cx JOIN firms f ON f.workspace_id=cx.workspace_id AND f.id=cx.firm_id
         WHERE cx.workspace_id=s.workspace_id AND cx.source_id=s.source_id AND ${mailContextPredicate()}
           AND (f.status<>'active' OR (NOT $4::boolean AND f.assigned_user_id IS DISTINCT FROM $3)))`,
      [context.scope.workspaceId, exact.sourceId, actor.userId, actor.role === 'admin'],
    );
    if (!visible.rows.length) return { ok: false, reason: 'source_unknown' };
  }
  const source = (
    await context.db.query<
      Control & {
        mailbox_id: string;
        acquired_generation: number;
        conversation_id: string;
        decision_revision: number;
        source_revision: number;
        content_hash: string;
        availability: string;
      }
    >('SELECT * FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2', [
      context.scope.workspaceId,
      exact.sourceId,
    ])
  ).rows[0];
  if (
    !source ||
    (source.owner_user_id !== purposeOwner && actor.role !== 'admin')
  )
    return { ok: false, reason: 'processing_authority_unavailable' };
  if (source.availability !== 'available')
    return { ok: false, reason: source.availability };
  if (
    source.source_revision !== exact.sourceRevision ||
    source.content_hash !== exact.contentHash
  )
    return { ok: false, reason: 'source_changed' };
  const veto = await context.db.query(
    'SELECT 1 FROM crm_mail_acquisition_tombstones WHERE workspace_id=$1 AND source_id=$2 AND source_revision >= $3 LIMIT 1',
    [context.scope.workspaceId, exact.sourceId, exact.sourceRevision],
  );
  if (veto.rows.length) return { ok: false, reason: 'source_deleted' };
  if (actor.role === 'admin' && source.owner_user_id !== actor.userId)
    await recordCrmAuditEvent(context, {
      action: 'crm.mail_source_admin_read',
      subjectKind: 'mail_source',
      subjectId: exact.sourceId,
      detail: { sourceRevision: source.source_revision },
    });
  const mailbox = (
    await context.db.query<Mailbox>(
      'SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2',
      [context.scope.workspaceId, source.mailbox_id],
    )
  ).rows[0];
  if (
    !mailbox ||
    mailbox.status !== 'connected' ||
    mailbox.owner_user_id !== source.owner_user_id ||
    businessAccountBinding(context.scope.workspaceId, mailbox) !==
      source.account_binding ||
    mailbox.provider_account_id !== source.provider_account_id
  )
    return { ok: false, reason: 'processing_binding_changed' };
  const control = (
    await context.db.query<Control>(
      'SELECT * FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2',
      [context.scope.workspaceId, mailbox.id],
    )
  ).rows[0];
  if (
    !control?.enabled ||
    control.owner_user_id !== source.owner_user_id ||
    control.account_binding !== source.account_binding ||
    control.generation !== mailbox.generation ||
    control.owner_user_id !== mailbox.owner_user_id
  )
    return { ok: false, reason: 'processing_policy_changed' };
  const policy = await context.db.query(
    'SELECT 1 FROM crm_business_policies WHERE workspace_id=$1 AND mailbox_id=$2 AND revision=$3 AND account_binding=$4 AND generation=$5',
    [
      context.scope.workspaceId,
      mailbox.id,
      control.policy_revision,
      control.account_binding,
      control.generation,
    ],
  );
  const conversation = (
    await context.db.query<Conversation>(
      'SELECT * FROM crm_business_conversations WHERE workspace_id=$1 AND id=$2',
      [context.scope.workspaceId, source.conversation_id],
    )
  ).rows[0];
  if (
    !policy.rows.length ||
    !conversation ||
    conversation.metadata_availability !== 'available' ||
    conversation.owner_user_id !== source.owner_user_id ||
    conversation.account_binding !== source.account_binding ||
    !(
      conversation.human_decision === 'include' ||
      (conversation.human_decision === null &&
        conversation.category === 'business')
    )
  )
    return { ok: false, reason: 'processing_decision_changed' };
  const proof: MailCaptureProof = {
    workspaceId: context.scope.workspaceId,
    mailboxId: mailbox.id,
    ownerUserId: source.owner_user_id,
    providerAccountId: source.provider_account_id,
    accountBinding: source.account_binding,
    generation: mailbox.generation,
    controlsRevision: control.revision,
    policyRevision: control.policy_revision,
    disclosureVersion: control.disclosure_version,
    disclosureSha256: control.disclosure_sha256,
    grantReceipt: control.grant_receipt,
    providerPolicyReceipt: control.provider_policy_receipt,
    evaluationReceipt: control.evaluation_receipt,
    releaseReceipt: control.release_receipt,
    captureVersion: MAIL_CAPTURE_VERSION,
  };
  if (!(await activeBusinessActor(context)))
    return { ok: false, reason: 'processing_authority_unavailable' };
  const final = (
    await context.db.query<{
      source_revision: number;
      content_hash: string;
      availability: string;
    }>(
      'SELECT source_revision,content_hash,availability FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2',
      [context.scope.workspaceId, exact.sourceId],
    )
  ).rows[0];
  if (
    !final ||
    final.availability !== 'available' ||
    final.source_revision !== exact.sourceRevision ||
    final.content_hash !== exact.contentHash
  )
    return { ok: false, reason: 'source_changed' };
  const bound = {
    exact: { ...exact },
    purposeOwner,
    proof,
    conversationId: source.conversation_id,
    decisionRevision: conversation.decision_revision,
    acquiredGeneration: source.acquired_generation,
  };
  return {
    ok: true,
    authority: {
      ...bound,
      authorizationFingerprint: createHash('sha256')
        .update(JSON.stringify(bound))
        .digest('hex'),
    },
  };
}
/** DB-only current snapshot comparison; a separate verified token is required before paid work. */
export async function revalidatePreparedMailProcessing(
  context: RepositoryContext,
  authority: CapturedMailProcessingAuthority,
): Promise<boolean> {
  const current = await prepareMailProcessingAuthority(
    context,
    authority.exact,
    authority.purposeOwner,
  );
  return (
    current.ok &&
    JSON.stringify(current.authority) === JSON.stringify(authority)
  );
}

/** DB-only original input under exact retained-copy locks; not a provider/model grant. */
export async function loadPreparedMailSourceInput(
  context: RepositoryContext,
  exact: ExactMailSource,
  authority: CapturedMailProcessingAuthority,
) {
  if (
    JSON.stringify(exact) !== JSON.stringify(authority.exact) ||
    !(await revalidatePreparedMailProcessing(context, authority))
  )
    return {
      state: 'unavailable',
      reason: 'processing_authority_unavailable',
      text: null,
    } as const;
  const original = await readMailConversation(context, exact);
  if (original.state !== 'available' || original.source.passage === null)
    return {
      state: 'unavailable',
      reason: 'body_unavailable',
      text: null,
    } as const;
  if (!(await revalidatePreparedMailProcessing(context, authority)))
    return {
      state: 'unavailable',
      reason: 'processing_authority_unavailable',
      text: null,
    } as const;
  return {
    state: 'available',
    text: original.source.passage,
    sourceId: exact.sourceId,
    sourceRevision: exact.sourceRevision,
    contentHash: exact.contentHash,
    parserVersion: original.source.parserVersion,
    representation: original.source.representation,
    completeness: original.source.completeness,
    ranges: original.source.ranges,
  } as const;
}

interface OriginalMailMatch {
  matchId: string;
  firmId: string;
  opportunityId: string;
  contactId: string | null;
  ambiguous: boolean;
  snapshotHash: string;
}
async function readOriginalMailMatches(
  input: JobHandlerInput,
  messageId: string | null,
  lock = false,
): Promise<OriginalMailMatch[] | null> {
  if (messageId === null) return [];
  const rows = (
    await input.session.query<{
      id: string;
      firm_id: string;
      opportunity_id: string;
      contact_id: string | null;
      ambiguous: boolean;
      selected: boolean | null;
      resolved_at: Date | null;
      created_at: Date;
      match_rule: string;
    }>(
      `SELECT id,firm_id,opportunity_id,contact_id,ambiguous,selected,resolved_at,created_at,match_rule FROM mail_message_matches WHERE workspace_id=$1 AND mail_message_id=$2 ORDER BY id LIMIT 101 ${lock ? 'FOR UPDATE' : ''}`,
      [input.scope.workspaceId, messageId],
    )
  ).rows;
  if (rows.length > 100) return null;
  return rows.map((row) => ({
    matchId: row.id,
    firmId: row.firm_id,
    opportunityId: row.opportunity_id,
    contactId: row.contact_id,
    ambiguous: row.ambiguous,
    snapshotHash: createHash('sha256')
      .update(JSON.stringify(row))
      .digest('hex'),
  }));
}
/** Firm closure precedes job, account, identity and message locks, including deletion's scope. */
async function lockOriginalMailContexts(
  input: JobHandlerInput,
  payload: CapturePayload,
) {
  const mailbox = (
    await input.session.query<Mailbox>(
      'SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2',
      [input.scope.workspaceId, payload.mailboxId],
    )
  ).rows[0];
  if (!mailbox) return null;
  const owner = (
    await input.session.query<{ role: string; status: string }>(
      'SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
      [input.scope.workspaceId, mailbox.owner_user_id],
    )
  ).rows[0];
  if (!owner || owner.status !== 'active') return null;
  const messageId =
    (
      await input.session.query<{ id: string }>(
        'SELECT id FROM mail_messages WHERE workspace_id=$1 AND mailbox_id=$2 AND provider_message_id=$3',
        [input.scope.workspaceId, payload.mailboxId, payload.providerMessageId],
      )
    ).rows[0]?.id ?? null;
  const matches = await readOriginalMailMatches(input, messageId);
  if (matches === null) return null;
  let recaptureContextFingerprint: string | null = null;
  if (payload.recapture) {
    if (owner.role !== 'admin' && owner.role !== 'salesperson') return null;
    const captured = (
      await input.session.query<MailContext>(
        `SELECT cx.* FROM crm_mail_source_contexts cx JOIN crm_mail_sources s ON s.workspace_id=cx.workspace_id AND s.source_id=cx.source_id WHERE s.workspace_id=$1 AND s.source_id=$2 AND s.source_revision=$3 AND ${mailContextPredicate()} ORDER BY cx.id LIMIT 101`,
        [
          input.scope.workspaceId,
          payload.recapture.sourceId,
          payload.recapture.expectedRevision,
        ],
      )
    ).rows;
    if (captured.length > 100) return null;
    const ownerContext = repositoryContext(
      workspaceScope(input.scope.workspaceId, {
        kind: 'user',
        userId: mailbox.owner_user_id,
        role: owner.role,
      }),
      input.session,
    );
    if (
      !(await lockIdentityContext(ownerContext, {
        firmIds: [
          ...new Set([
            ...matches.map((match) => match.firmId),
            ...captured.flatMap((cx) => (cx.firm_id ? [cx.firm_id] : [])),
          ]),
        ].sort(),
        personIds: [
          ...new Set(
            captured.flatMap((cx) => (cx.person_id ? [cx.person_id] : [])),
          ),
        ].sort(),
      }))
    )
      return null;
    recaptureContextFingerprint = createHash('sha256')
      .update(JSON.stringify(captured))
      .digest('hex');
  }
  let adminException = false;
  for (const firmId of [
    ...new Set(matches.map((match) => match.firmId)),
  ].sort()) {
    const firm = (
      await input.session.query<{
        assigned_user_id: string | null;
        status: string;
      }>(
        'SELECT assigned_user_id,status FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [input.scope.workspaceId, firmId],
      )
    ).rows[0];
    if (
      !firm ||
      firm.status !== 'active' ||
      (owner.role !== 'admin' &&
        firm.assigned_user_id !== mailbox.owner_user_id)
    )
      return null;
    if (
      owner.role === 'admin' &&
      firm.assigned_user_id !== mailbox.owner_user_id
    )
      adminException = true;
  }
  const after = await readOriginalMailMatches(input, messageId);
  if (after === null || JSON.stringify(after) !== JSON.stringify(matches))
    return null;
  return { messageId, matches, adminException, recaptureContextFingerprint };
}

export const approvedBusinessMailObservationSchema = z
  .object({
    ownerUserId: z.string().uuid(),
    observation: businessMetadataObservationSchema,
  })
  .strict();
/** Metadata review is not body permission. This only creates a separately verified worker intent. */
export async function observeApprovedBusinessMail(
  context: RepositoryContext,
  value: unknown,
) {
  if (
    context.scope.actor.kind !== 'system' ||
    context.scope.actor.component !== 'worker'
  )
    return { ok: false as const, reason: 'system_observer_required' };
  const parsed = approvedBusinessMailObservationSchema.safeParse(value);
  if (!parsed.success)
    return { ok: false as const, reason: 'invalid_metadata' };
  const { ownerUserId, observation } = parsed.data;
  const mailbox = (
    await context.db.query<Mailbox>(
      'SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE',
      [context.scope.workspaceId, observation.mailboxId],
    )
  ).rows[0];
  if (
    !mailbox ||
    mailbox.owner_user_id !== ownerUserId ||
    mailbox.provider_account_id !== observation.providerAccountId ||
    mailbox.generation !== observation.generation ||
    mailbox.status !== 'connected'
  )
    return { ok: false as const, reason: 'mailbox_binding_changed' };
  const observed = await observeBusinessMetadata(context, observation);
  if (!observed.ok || observed.value.conversationId === null) return observed;
  const control = (
    await context.db.query<Control>(
      'SELECT * FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2',
      [context.scope.workspaceId, observation.mailboxId],
    )
  ).rows[0];
  const binding = businessAccountBinding(context.scope.workspaceId, mailbox);
  const conversation = (
    await context.db.query<Conversation>(
      'SELECT * FROM crm_business_conversations WHERE workspace_id=$1 AND id=$2',
      [context.scope.workspaceId, observed.value.conversationId],
    )
  ).rows[0];
  if (
    !control?.enabled ||
    control.owner_user_id !== ownerUserId ||
    control.account_binding !== binding ||
    control.provider_account_id !== observation.providerAccountId ||
    control.generation !== observation.generation ||
    control.policy_revision !== observation.expectedPolicyRevision ||
    !conversation ||
    conversation.metadata_availability !== 'available' ||
    conversation.account_binding !== binding ||
    !(
      conversation.human_decision === 'include' ||
      (conversation.human_decision === null &&
        conversation.category === 'business')
    )
  )
    return {
      ok: true as const,
      value: { ...observed.value, captureQueued: false },
    };
  const prior = (
    await context.db.query<{ state: string }>(
      'SELECT state FROM crm_mail_capture_identities WHERE workspace_id=$1 AND mailbox_id=$2 AND account_binding=$3 AND provider_message_id=$4',
      [
        context.scope.workspaceId,
        mailbox.id,
        binding,
        observation.providerMessageId,
      ],
    )
  ).rows[0];
  if (prior?.state === 'copied' || prior?.state === 'blocked')
    return {
      ok: true as const,
      value: { ...observed.value, captureQueued: false },
    };
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        binding,
        messageId: observation.providerMessageId,
        generation: observation.generation,
        controlsRevision: control.revision,
        policyRevision: control.policy_revision,
        decisionRevision: conversation.decision_revision,
      }),
    )
    .digest('hex');
  await enqueueJob(context.db, {
    workspaceId: context.scope.workspaceId,
    kind: 'crm.mail_capture',
    idempotencyKey: `crm-mail-capture:${key}`,
    payload: {
      mailboxId: mailbox.id,
      providerMessageId: observation.providerMessageId,
      providerAccountId: observation.providerAccountId,
      generation: observation.generation,
      conversationId: conversation.id,
      controlsRevision: control.revision,
      policyRevision: control.policy_revision,
      decisionRevision: conversation.decision_revision,
    },
  });
  return {
    ok: true as const,
    value: { ...observed.value, captureQueued: true },
  };
}
/** Account provenance is passed by the sync run, never reconstructed from today's mailbox. */
export function createApprovedBusinessMailObserver(
  options: {
    categorizeMetadata?: (
      metadata: GmailMessageMetadata,
    ) => Pick<
      z.infer<typeof businessMetadataObservationSchema>,
      'category' | 'reason' | 'classifierVersion'
    >;
  } = {},
): BusinessMailMetadataObserver {
  return {
    async observe(context, input) {
      const policy = (
        await context.db.query<{ revision: number }>(
          'SELECT revision FROM crm_business_policies WHERE workspace_id=$1 AND mailbox_id=$2',
          [context.scope.workspaceId, input.mailboxId],
        )
      ).rows[0];
      if (!policy) return;
      const classification = options.categorizeMetadata?.(input.metadata) ?? {
        category: 'uncertain',
        reason: 'unclassified_metadata',
        classifierVersion: 'business-metadata-unclassified-v1',
      };
      const participants = [
        headerValue(input.metadata.headers, 'From'),
        headerValue(input.metadata.headers, 'To'),
        headerValue(input.metadata.headers, 'Cc'),
      ]
        .flatMap((header) =>
          [...(header ?? '').matchAll(/([^<>\s,]+@[^<>\s,]+)/gu)].map(
            (match) => match[1]!,
          ),
        )
        .map((value) => normalizeIdentityEndpoint('email', value));
      if (
        participants.length > 50 ||
        participants.some((value) => value === null)
      )
        return;
      await observeApprovedBusinessMail(context, {
        ownerUserId: input.ownerUserId,
        observation: {
          mailboxId: input.mailboxId,
          providerAccountId: input.providerAccountId,
          generation: input.generation,
          expectedPolicyRevision: policy.revision,
          providerThreadId: input.metadata.threadId,
          providerMessageId: input.metadata.id,
          subject: (headerValue(input.metadata.headers, 'Subject') ?? '').slice(
            0,
            500,
          ),
          participants,
          latestProviderAt: new Date(
            input.metadata.internalDateEpochMilliseconds,
          ).toISOString(),
          ...classification,
        },
      });
    },
  };
}
