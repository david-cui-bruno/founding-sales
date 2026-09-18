import { z } from 'zod';

import { accountClaimSchema, accountSchema, accountSourceSchema, type AccountClaim, type AccountSource } from '../../../../src/shared/contracts/accountContract';
import { campaignVersionSchema, enrollmentSchema, type CampaignVersion } from '../../../../src/shared/contracts/campaignContract';
import { ownerSourceConfigurationSchema, ownerSourceKey, type OwnerSourceConfiguration } from '../../../../src/shared/contracts/ownerCommandContract';
import { type ReplyTemplateHoldReason, type ReplyTemplateId, type ReplyTemplatePurpose } from '../../../../src/shared/contracts/replyTemplateContract';
import { REPLY_TEMPLATE_SEEDS } from '../../../../src/main/outreach/templates/replyTemplateSeeds';
import { templateSequenceEmailActionId, templateSequenceEmailCommandId, templateSequenceEmailPermissionId,
  templateSequenceEmailValues } from '../../../../src/shared/outreach/templateSequenceEmail';
import { createDispatchService } from './dispatchService';
import { dispatchIntentKey, templateSequencePermissionKey, type DynamoDispatchRepository, type TemplateSequenceEmailIntent } from './dispatchRepository';
import { DynamoStore, fingerprint, keyPart, type RepositoryOptions } from './dynamoStore';
import { authorityRecordSchema, executionAuthorityKey, type DynamoExecutionRepository } from './executionRepository';
import { type RemoteGoogleAuthorization } from './remoteGoogleAuthorization';
import { mailSuppressionKey } from './threadIntakeRepository';
import { TerritoryPolicyRepository } from './territoryPolicyRepository';
import { WorkerCampaignRepository, campaignEnrollmentKey, campaignVersionKey } from './workerCampaignRepository';

/**
 * The walker that sends a due sequence email step (D13, lane 40).
 *
 * Lane 31 shipped the standing template approval and the send-or-hold decision. Lane 39 shipped the
 * business email claim, the cold first-email intent, its permission and its reservation. Nothing
 * walked a due step and put the two together, so no sequence email had ever been assembled. This does
 * exactly that and nothing more: for each firm the territory sweep already scanned this tick, it finds
 * the email steps whose day has arrived, asks `planTemplateEmailStep`, and then either hands the send
 * to the existing dispatch service or records the decision's own closed hold reason on the step.
 *
 * What it never does: invent a recipient, re-read the template text, decide that something was sent,
 * dial, book, or advance the firm's call cadence. The cadence walked past its email steps the moment a
 * call outcome advanced it (lane 26's rule) and this changes none of that.
 */

/** At most this many sends per scheduled tick. The sender's own daily cap and warm-up ramp are separate and stricter. */
export const TERRITORY_EMAIL_TICK_SEND_LIMIT = 25;
/** How long a recorded permission to write one cold first email stays usable. One tick's work, not a standing permission. */
const PERMISSION_TTL_MS = 3_600_000;
/** An outcome that means the firm has answered. The sequence never emails a firm that answered, whatever the step says. */
const ANSWERED_OUTCOMES: ReadonlySet<string> = new Set(['not_interested', 'wrong_number', 'opt_out', 'booked', 'reply']);
/** The enrollment states an email step may still go out under. `paused` is the D13 rest, whose last step is an email. */
const EMAILABLE_STATES: ReadonlySet<string> = new Set(['active', 'paused']);
/**
 * Which of lane 31's five closed reasons each refusal of the dispatch path is. The two the dispatch path already
 * answers in lane 31's own words map to themselves; the shared cap is the sender cap; and every condition about
 * the mailbox the firm's mail would come from or go through — an unfinished intake, a scope that does not name
 * the recipient, a grant that no longer carries `send` — is the mailbox not being connected for that firm. A
 * refusal absent from this map is not one of the five and is never written on a step as if it were.
 */
const DISPATCH_HOLD_REASONS: ReadonlyMap<string, ReplyTemplateHoldReason> = new Map([
  ['template_not_approved', 'template_not_approved'],
  ['no_business_email', 'no_business_email'],
  ['dispatch_cap_reached', 'sender_cap_reached'],
  ['mailbox_not_connected', 'mailbox_not_connected'],
  ['intake_unavailable', 'mailbox_not_connected'],
  ['intake_incomplete', 'mailbox_not_connected'],
  ['intake_stale', 'mailbox_not_connected'],
  ['intake_scope_missing', 'mailbox_not_connected'],
  ['sender_identity_conflict', 'mailbox_not_connected'],
  ['google_access_evidence_missing', 'mailbox_not_connected'],
]);

export type SequenceEmailReport = {
  /** Firms whose enrollment record this walk actually looked at. */
  scanned: number;
  /** Email steps whose day had arrived and which had not already gone out. */
  due: number;
  /** Steps the provider accepted. */
  sent: number;
  /** Steps held, each under one of lane 31's five closed reasons. */
  held: number;
  /** Firms whose walk threw something unexpected. Never counted as a hold: a hold is a named condition. */
  failed: number;
  heldByReason: Partial<Record<ReplyTemplateHoldReason, number>>;
};
export const emptySequenceEmailReport = (): SequenceEmailReport =>
  ({ scanned: 0, due: 0, sent: 0, held: 0, failed: 0, heldByReason: {} });

export type SequenceEmailDependencies = {
  options: RepositoryOptions;
  policy: DynamoDispatchRepository;
  execution: DynamoExecutionRepository;
  authorization: RemoteGoogleAuthorization;
  fetch: typeof globalThis.fetch;
};

const accountRecordShape = z.object({ account: accountSchema, sources: z.array(accountSourceSchema), claims: z.array(accountClaimSchema) });
/** The one cited `business_email` claim of a firm, with the index and the source the permission must name. */
type BusinessEmail = { email: string; claimIndex: number; claim: AccountClaim; source: AccountSource; accountVersion: number; name: string; sources: readonly AccountSource[] };

function readBusinessEmail(data: unknown): BusinessEmail | null {
  const parsed = accountRecordShape.safeParse(data);
  if (!parsed.success) return null;
  const record = parsed.data;
  const claimIndex = record.claims.findIndex(claim => claim.key === 'business_email' && claim.kind === 'fact');
  const claim = claimIndex < 0 ? undefined : record.claims[claimIndex];
  if (!claim || claim.key !== 'business_email' || typeof claim.value !== 'string' || claim.evidenceIds.length !== 1) return null;
  const sourceId = claim.evidenceIds[0];
  const cited = record.sources.filter(source => source.id === sourceId);
  const source = cited[0];
  // Exactly the citation the reservation re-checks: one permitted source, and no second source with the same id.
  if (cited.length !== 1 || !source || !source.permitted) return null;
  return { email: claim.value, claimIndex, claim, source, accountVersion: record.account.version,
    name: record.account.name, sources: record.sources };
}

/**
 * Whether the firm's own sequence still is the sequence the approved policy states, channel for
 * channel. The derived campaign version carries step ids, channels and delays but not the template
 * each email step names, so the template can only be read off the policy by position — and reading it
 * by position is only sound while the positions still line up. A firm whose sequence no longer matches
 * the standing policy is left alone rather than emailed from a template nobody lined up with its step.
 */
function alignedSequence(version: Pick<CampaignVersion, 'steps'>, sequence: readonly { channel: string; templateKey?: ReplyTemplateId }[]): boolean {
  return version.steps.length === sequence.length
    && version.steps.every((step, index) => step.channel === sequence[index]?.channel);
}

export function createSequenceEmailWalker(input: SequenceEmailDependencies) {
  const store = new DynamoStore(input.options);
  const territory = new TerritoryPolicyRepository(input.options);
  const campaigns = new WorkerCampaignRepository(input.options);

  /** Today's recorded sends for one sender, from the sender's own cap row. An absent row is zero sends, not an absent cap. */
  async function sentToday(sender: string): Promise<number> {
    const row = await store.get<unknown>(`DISPATCH_CAP#${keyPart(sender)}#${store.now().slice(0, 10)}`);
    const parsed = z.object({ sender: z.string(), used: z.number().int().nonnegative() }).safeParse(row?.data);
    return parsed.success && parsed.data.sender === sender ? parsed.data.used : 0;
  }

  /**
   * The mailbox this firm's cold email would leave from, or null. Both halves are David's own recorded
   * decisions and neither is inferred: the firm's active owner source names the mailbox subject, and the
   * worker-held grant for the approving pairing carries `send` for exactly that subject. A firm with no
   * mailbox on its owner source holds with `mailbox_not_connected`, which is the truth about that firm.
   */
  async function sender(pairingId: string, mailboxSubject: string | null): Promise<string | null> {
    if (mailboxSubject === null) return null;
    const status = await input.authorization.status(pairingId);
    const grant = status.grant;
    if (status.state !== 'ready' || !grant || grant.purpose !== 'permitted_correspondence' || grant.owner !== 'remote'
      || grant.subject !== mailboxSubject) return null;
    const capabilities: readonly string[] = grant.capabilities;
    return capabilities.includes('send') && capabilities.includes('relevant_read') ? grant.email : null;
  }

  /** One firm's due email steps. Every refusal here is either a named hold on the step or leaving the firm untouched. */
  async function walkFirm(accountId: string, report: SequenceEmailReport, signal: AbortSignal): Promise<void> {
    const current = await territory.read();
    if (!current || current.data.state !== 'active') return;
    const policy = current.data;
    const enrolled = await territory.readEnrollmentRecord(accountId);
    if (!enrolled || !enrolled.data.heldSteps.length) return;
    const record = enrolled.data;
    const versionRow = await store.get<unknown>(campaignVersionKey(record.versionId));
    if (!versionRow) return;
    const version = campaignVersionSchema.parse(versionRow.data);
    if (version.id !== record.versionId) throw new Error('territory_email_identity_conflict');
    // A record whose steps carry their own frozen template needs no alignment at all: lane 41 froze the
    // template on each held step at enrollment, so the step names its template whatever the live policy
    // revision now says. Only a record written before that has to read the template off the policy by
    // position, and reading by position is sound only while the positions still line up.
    const frozen = record.heldSteps.every(step => step.templateId !== undefined);
    if (!frozen && !alignedSequence(version, policy.sequence)) return;
    const enrollmentRow = await store.get<unknown>(campaignEnrollmentKey(record.enrollmentId));
    if (!enrollmentRow) return;
    const enrollment = enrollmentSchema.parse(enrollmentRow.data);
    if (enrollment.accountId !== accountId || enrollment.campaignVersionId !== record.versionId) throw new Error('territory_email_identity_conflict');
    if (!EMAILABLE_STATES.has(enrollment.state)) return;
    // A firm that replied, opted out, booked, said no or answered on a wrong number is done with the sequence.
    const evidence = await campaigns.evidence(enrollment.id);
    if (evidence.some(item => item.conflict || item.observation === 'replied' || ANSWERED_OUTCOMES.has(item.outcome))) return;
    // A suppressed firm is its own decision, not a hold on a step: it is left entirely alone, and no reason
    // out of the five would be true of it. The reservation refuses it as well, which is the durable fence.
    if (await store.get(mailSuppressionKey(accountId))) return;
    const sourceRow = await store.get<unknown>(ownerSourceKey(accountId));
    const configuration = ownerSourceConfigurationSchema.safeParse(sourceRow?.data);
    if (!configuration.success || configuration.data.accountId !== accountId
      || configuration.data.workspaceId !== input.options.workspaceId || configuration.data.state !== 'active') return;
    const authorityRow = await store.get<unknown>(executionAuthorityKey(accountId));
    const authority = authorityRecordSchema.safeParse(authorityRow?.data);
    if (!authority.success || authority.data.authority.accountId !== accountId || authority.data.authority.owner !== 'worker'
      || authority.data.authority.state !== 'active') return;
    report.scanned++;
    const sent = new Set((record.sentSteps ?? []).map(step => step.stepId));
    const now = store.now();
    const startedAt = Date.parse(enrollment.startedAt);
    for (const held of record.heldSteps) {
      if (signal.aborted || report.sent >= TERRITORY_EMAIL_TICK_SEND_LIMIT) return;
      if (sent.has(held.stepId)) continue;
      const index = version.steps.findIndex(step => step.id === held.stepId);
      const step = index < 0 ? undefined : version.steps[index];
      const templateId = held.templateId ?? (index < 0 ? undefined : policy.sequence[index]?.templateKey);
      if (!step || step.channel !== 'email' || !templateId) continue;
      // Day offsets are calendar days from the enrollment's own start, which a re-entry re-bases on the restart.
      const dueAt = startedAt + step.delayHours * 3_600_000;
      if (!Number.isFinite(dueAt) || dueAt > Date.parse(now)) continue;
      report.due++;
      await walkStep({ accountId, templateId, step: { id: held.stepId }, record, enrollment, configuration: configuration.data,
        authorityGeneration: authority.data.authority.generation, report, signal });
    }
  }

  /** One due email step: the decision, and then either the send it permits or the reason it refused. */
  async function walkStep(context: {
    accountId: string; templateId: ReplyTemplateId; step: { id: string };
    record: { enrollmentId: string; versionId: string };
    enrollment: { id: string };
    configuration: Pick<OwnerSourceConfiguration, 'pairingId' | 'mailboxSubject'>;
    authorityGeneration: number; report: SequenceEmailReport; signal: AbortSignal;
  }): Promise<void> {
    const { accountId, templateId, report } = context;
    const identity = { accountId, templateId, stepId: context.step.id };
    const hold = async (reason: ReplyTemplateHoldReason) => {
      report.held++;
      report.heldByReason[reason] = (report.heldByReason[reason] ?? 0) + 1;
      await territory.recordEmailStepOutcome({ accountId, stepId: context.step.id, hold: reason });
    };
    const accountRow = await store.get<unknown>(`ACCOUNT#${keyPart(accountId)}`);
    const business = accountRow ? readBusinessEmail(accountRow.data) : null;
    const from = await sender(context.configuration.pairingId, context.configuration.mailboxSubject);
    const values = business ? templateSequenceEmailValues({ name: business.name, sources: business.sources }) : {};
    const decision = await territory.planTemplateEmailStep({ templateId, pairingId: context.configuration.pairingId, values,
      grant: async () => from !== null, senderCap: async () => {
        if (from === null) return null;
        const cap = await input.authorization.senderCap(from);
        return cap ? { today: cap.today, sentToday: await sentToday(from) } : null;
      } });
    if ('hold' in decision) { await hold(decision.hold); return; }
    // The decision says the approved text may go out; the recipient is a separate recorded fact.
    if (!business || from === null || context.configuration.mailboxSubject === null) { await hold('no_business_email'); return; }
    const mailboxSubject = context.configuration.mailboxSubject;
    const commandId = templateSequenceEmailCommandId(identity);
    const actionId = templateSequenceEmailActionId(identity);
    const permissionId = templateSequenceEmailPermissionId(identity);
    const frozenMessage = { commandId, from, to: business.email, subject: decision.send.rendered.subject, body: decision.send.rendered.body };
    const intent: TemplateSequenceEmailIntent = { kind: 'template_sequence_email', commandId, pairingId: context.configuration.pairingId,
      mailboxSubject, draftId: `${actionId}-text`, draftRevision: decision.send.revision, frozenMessage,
      binding: { kind: 'account_claim', claimIndex: business.claimIndex, accountVersion: business.accountVersion, email: business.email },
      stepId: context.step.id, campaignVersionId: context.record.versionId, enrollmentId: context.enrollment.id,
      template: { templateId, revision: decision.send.revision, contentHash: decision.send.contentHash, purpose: templatePurpose(templateId) },
      action: { workspaceId: input.options.workspaceId, accountId, actionId, expectedAuthorityGeneration: context.authorityGeneration,
        approvalId: permissionId, contentHash: fingerprint(frozenMessage), targetHash: fingerprint({ sender: from, recipient: business.email }) } };
    const now = store.now();
    // Each admission is written once. A tick that died between two of them finds its own record and
    // continues instead of admitting a second one; every id above is derived, never minted fresh.
    if (!await store.get(templateSequencePermissionKey(accountId, permissionId))) {
      await input.policy.admitTemplateSequencePermission({ basis: 'listed_business_email', id: permissionId, accountId,
        recipient: business.email, sender: from, mailboxSubject, accountVersion: business.accountVersion,
        claimIndex: business.claimIndex, claimFingerprint: fingerprint(business.claim), sourceId: business.source.id,
        sourceSha256: business.source.sha256, recordedAt: now, expiresAt: new Date(Date.parse(now) + PERMISSION_TTL_MS).toISOString() });
    }
    if (!await store.get(dispatchIntentKey(commandId))) await input.policy.admitIntent(intent);
    await input.execution.prepareAction({ ...intent.action, expectedVersion: await input.execution.currentVersion(accountId) });
    const outcome = await createDispatchService({ execution: input.execution, policy: input.policy,
      authorization: input.authorization, fetch: input.fetch }).dispatch(commandId, context.signal);
    if (outcome.status !== 'provider_accepted') {
      // Only a refusal that one of the five closed reasons actually describes is written on the step. Anything
      // else is an unexpected condition, and counting it as a named hold would put a reason on the record that
      // is not true of the firm; it becomes a tick hold instead, under the phase's own words.
      const reason = DISPATCH_HOLD_REASONS.get(outcome.reason);
      if (!reason) throw new Error('sequence_email_unexpected_hold');
      await hold(reason);
      return;
    }
    report.sent++;
    await territory.recordEmailStepOutcome({ accountId, stepId: context.step.id, sent: { templateId, commandId, sentAt: store.now() } });
  }

  return {
    /**
     * Walk the firms the territory sweep already scanned this tick. Bounded twice over: the sweep's own
     * page is what decides which firms are looked at, and no tick sends more than
     * `TERRITORY_EMAIL_TICK_SEND_LIMIT` emails however many steps are due.
     */
    async walkDueEmailSteps(accountIds: readonly string[], signal: AbortSignal): Promise<SequenceEmailReport> {
      const report = emptySequenceEmailReport();
      for (const accountId of new Set(accountIds)) {
        if (signal.aborted || report.sent >= TERRITORY_EMAIL_TICK_SEND_LIMIT) return report;
        try { await walkFirm(accountId, report, signal); }
        catch { report.failed++; }
      }
      return report;
    },
  };
}

/** A template's purpose, read from the seeded templates rather than retyped here: schema 30 freezes a template's
 *  purpose for the life of the row, so the seed is what the desktop and the worker both mean by it. */
function templatePurpose(templateId: ReplyTemplateId): ReplyTemplatePurpose {
  const seed = REPLY_TEMPLATE_SEEDS.find(entry => entry.id === templateId);
  if (!seed) throw new Error('reply_template_seed_unknown');
  return seed.purpose;
}
