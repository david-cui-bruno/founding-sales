import { CALLIE_PRODUCT_FACTS } from '../../shared/product/callieProductFacts';
import type { ActionState, DelegationCommand } from '../../shared/contracts/delegationContract';
import { linkedInBeginSchema, linkedInPrepareSchema, type LinkedInBegin, type LinkedInDraft, linkedInRevisionSchema, linkedInReportSchema, type LinkedInApi, type LinkedInPrepare, type LinkedInSave, type LinkedInRevision, type LinkedInReport } from '../../shared/contracts/linkedInContract';
import { approvedLinkedInFactsSchema, type ApprovedLinkedInFacts, type LinkedInDraftProvider } from './linkedInDraftProvider';
import type { DelegationRepository } from '../delegation/delegationRepository';
import type { ExecutionClient } from '../delegation/executionClient';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { prepareManualCommandSchema, completeManualCommandSchema } from '../../shared/contracts/ownerCommandContract';
import type { LinkedInRepository } from './linkedInRepository';
export function validateLinkedInTarget(target: string): string {
  if (!/^https:\/\/(?:www\.)?linkedin\.com\/(?:in\/[A-Za-z0-9_-]+|messaging\/thread\/[A-Za-z0-9_-]+)\/?$/.test(target)) throw new Error('linkedin_target_invalid');
  return target;
}
/** Presentation helper only. Owner-applied evidence is the sole outcome authority. */
export function reduceManualStatus(state: ActionState, event: 'copied' | 'opened' | 'reported_sent'): ActionState {
  return state === 'prepared' && event === 'reported_sent' ? 'human_reported_sent' : state;
}
export class LinkedInService implements LinkedInApi {
  private readonly lifetime = new AbortController();
  constructor(private readonly deps: { repository: LinkedInRepository; provider?: LinkedInDraftProvider; productFacts?: ApprovedLinkedInFacts; owner?: { repository: DelegationRepository; client: ExecutionClient }; shell?: { openExternal(url: string): Promise<void> }; clipboard?: { writeText(text: string): Promise<void> | void } }) {}
  dispose() { this.lifetime.abort(); }
  private assertCurrent() { if (this.lifetime.signal.aborted) throw new Error('linkedin_disposed'); }
  async prepare(raw: LinkedInPrepare) {
    this.assertCurrent(); const input = linkedInPrepareSchema.parse(raw);
    const context = this.deps.repository.requireStep(input.stepId, input.expectedVersion);
    this.assertNoPending(context.accountId);
    validateLinkedInTarget(context.target);
    const existing = this.deps.repository.find(context); if (existing) return existing;
    if (!this.deps.provider) throw new Error('provider_unconfigured');
    const product = approvedLinkedInFactsSchema.parse(this.deps.productFacts ?? CALLIE_PRODUCT_FACTS);
    const source = this.deps.repository.generationContext(context);
    const generated = await this.deps.provider.generate({ ...source, facts: [...source.facts, ...product.facts], productApprovalId: product.approvalId, productFactsVersion: product.version, productSourceRef: product.sourceRef, productApprovalKind: product.approvalKind }, this.lifetime.signal);
    this.assertCurrent();
    return this.deps.repository.create(context, generated.body);
  }
  async save(input: LinkedInSave) { this.assertCurrent(); return this.deps.repository.save(input); }
  async get(raw: LinkedInRevision) { this.assertCurrent(); const input = linkedInRevisionSchema.parse(raw); return this.deps.repository.requireRevision(input.draftId, input.expectedRevision); }
  async open(raw: LinkedInRevision) {
    this.assertCurrent(); const input = linkedInRevisionSchema.parse(raw); const { draft, context } = this.deps.repository.requireAction(input.draftId, input.expectedRevision);
    this.assertNoPending(draft.accountId);
    const target = validateLinkedInTarget(context.target);
    if (!this.deps.shell) throw new Error('shell_unconfigured');
    await this.deps.shell.openExternal(target);
    return { draftId: draft.id, revision: draft.revision, status: 'opened' as const };
  }
  async copy(raw: LinkedInRevision) {
    this.assertCurrent(); const input = linkedInRevisionSchema.parse(raw); const { draft } = this.deps.repository.requireAction(input.draftId, input.expectedRevision);
    this.assertNoPending(draft.accountId);
    if (!this.deps.clipboard) throw new Error('clipboard_unconfigured');
    await this.deps.clipboard.writeText(draft.body);
    return { draftId: draft.id, revision: draft.revision, status: 'copied' as const };
  }
  private owner() { if (!this.deps.owner) throw new Error('owner_protocol_unconfigured'); return this.deps.owner; }
  private assertNoPending(accountId: string) {
    if (this.deps.owner?.repository.pendingCommands().some(command => command.accountId === accountId && ['pause', 'revoke', 'complete-manual'].includes(command.kind))) throw new Error('owner_reconciliation_pending');
  }
  private envelope(commandId: string, draft: LinkedInDraft) {
    const repository = this.owner().repository; const authority = repository.authority(draft.accountId); const version = repository.executionVersion(draft.accountId);
    if (!authority || authority.owner !== 'worker' || version === null) throw new Error('owner_unavailable');
    return { commandId, workspaceId: draft.workspaceId, accountId: draft.accountId, expectedAuthorityGeneration: authority.generation, expectedVersion: version };
  }
  private replay(command: DelegationCommand) {
    const previous = this.owner().repository.getCommand(command.commandId);
    if (!previous) return command;
    if (previous.kind !== command.kind || previous.workspaceId !== command.workspaceId || previous.accountId !== command.accountId
      || accountFingerprint(previous.payload) !== accountFingerprint(command.payload)) throw new Error('owner_command_conflict');
    return previous;
  }
  private handoff(draft: LinkedInDraft) {
    const id = this.deps.repository.handoffId(draft); const handoff = id === null ? null : this.owner().repository.getManualHandoff(id);
    if (!handoff || handoff.accountId !== draft.accountId || handoff.actionId !== `${draft.id}:${draft.revision}` || handoff.channel !== 'linkedin'
      || handoff.contentHash !== draft.contentHash || handoff.targetHash !== draft.targetHash || handoff.contextRevision !== draft.executionContextId
      || handoff.routeId !== draft.routeId || handoff.routeVersion !== draft.routeVersion || handoff.campaign.enrollmentId !== draft.enrollmentId
      || handoff.campaign.stepId !== draft.stepId) throw new Error('handoff_not_started');
    return handoff;
  }
  async begin(raw: LinkedInBegin): ReturnType<LinkedInApi['begin']> {
    this.assertCurrent(); const input = linkedInBeginSchema.parse(raw);
    const { draft, context } = this.deps.repository.requireAction(input.draftId, input.expectedRevision);
    this.assertNoPending(draft.accountId); validateLinkedInTarget(context.target);
    const owner = this.owner();
    const approval = this.deps.repository.approve(input);
    const command = this.replay(prepareManualCommandSchema.parse({ ...this.envelope(input.commandId, draft), kind: 'prepare-manual', payload: approval.binding }));
    await owner.client.submit(command);
    const sync = await owner.client.sync(this.lifetime.signal); this.assertCurrent();
    const receipt = owner.repository.commandStatus(input.commandId); if (!receipt) throw new Error('owner_receipt_missing');
    if (receipt.status === 'rejected') throw new Error('owner_begin_rejected');
    if (receipt.status !== 'applied' || !sync.ownerFresh) return { draftId: draft.id, revision: draft.revision, status: 'pending', handoffId: null, receipt };
    this.deps.repository.requireAction(draft.id, draft.revision);
    const full = this.handoff(draft);
    const { consumedAt, ...handoff } = full;
    void consumedAt;
    const result = owner.repository.consumeManualHandoff(handoff, () => {
      this.assertCurrent(); this.assertNoPending(draft.accountId); this.deps.repository.requireAction(draft.id, draft.revision);
    });
    return { draftId: draft.id, revision: draft.revision, receipt, ...result };
  }
  async reportOutcome(raw: LinkedInReport): ReturnType<LinkedInApi['reportOutcome']> {
    this.assertCurrent(); const input = linkedInReportSchema.parse(raw);
    const draft = this.deps.repository.requireRevision(input.draftId, input.expectedRevision);
    const owner = this.owner(); const handoff = this.handoff(draft);
    if (handoff.consumedAt === null) throw new Error('handoff_not_started');
    this.deps.repository.assertObservedAt(input.observedAt, handoff.consumedAt);
    const command = this.replay(completeManualCommandSchema.parse({ ...this.envelope(input.commandId, draft), kind: 'complete-manual',
      payload: { handoffId: handoff.handoffId, targetHash: draft.targetHash, outcome: { actionId: handoff.actionId, channel: 'linkedin', outcome: input.outcome,
        observedAt: input.observedAt, evidenceRef: input.commandId, ...(input.replyText === undefined ? {} : { replyText: input.replyText }) } } }));
    await owner.client.submit(command);
    await owner.client.sync(this.lifetime.signal); this.assertCurrent();
    const receipt = owner.repository.commandStatus(input.commandId); if (!receipt) throw new Error('owner_receipt_missing');
    return { draftId: draft.id, revision: draft.revision, receipt };
  }
}
