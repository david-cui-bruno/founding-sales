import type { z } from 'zod';
import type { AppDatabase } from '../db/database';
import { CALLIE_PRODUCT_FACTS } from '../../shared/product/callieProductFacts';
import type { ActionState, DelegationCommand } from '../../shared/contracts/delegationContract';
import { linkedInSaveSchema, linkedInBeginSchema, linkedInPrepareSchema, type LinkedInBegin, linkedInRevisionSchema, linkedInReportSchema, type LinkedInApi, type LinkedInPrepare, type LinkedInSave, type LinkedInRevision, type LinkedInReport } from '../../shared/contracts/linkedInContract';
import { approvedLinkedInFactsSchema, type ApprovedLinkedInFacts, type LinkedInDraftProvider } from './linkedInDraftProvider';
import type { DelegationRepository } from '../delegation/delegationRepository';
import type { ExecutionClient } from '../delegation/executionClient';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { prepareManualCommandSchema, completeManualCommandSchema } from '../../shared/contracts/ownerCommandContract';
import { LinkedInRepository, type LinkedInActionIdentity } from './linkedInRepository';
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
    this.deps.repository.assertEnrollment(input.enrollmentId);
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
  private envelope(commandId: string, draft: LinkedInActionIdentity) {
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
  private handoff(draft: LinkedInActionIdentity) {
    const id = this.deps.repository.handoffId(draft); const handoff = id === null ? null : this.owner().repository.getManualHandoff(id);
    if (!handoff || handoff.accountId !== draft.accountId || handoff.actionId !== `${draft.id}:${draft.revision}` || handoff.channel !== 'linkedin'
      || handoff.contentHash !== draft.contentHash || handoff.targetHash !== draft.targetHash || handoff.contextRevision !== draft.executionContextId
      || handoff.routeId !== draft.routeId || handoff.routeVersion !== draft.routeVersion || handoff.campaign.enrollmentId !== draft.enrollmentId
      || handoff.campaign.stepId !== draft.stepId) throw new Error('handoff_not_started');
    return handoff;
  }
  private assertBeginAttempt(input: LinkedInBegin) {
    const { draft } = this.deps.repository.requireAction(input.draftId, input.expectedRevision);
    this.assertCurrent(); this.assertNoPending(draft.accountId);
    const record = this.deps.repository.actionRecord(input.draftId, input.expectedRevision);
    const repository = this.owner().repository;
    const other = record.commandIds.filter(id => id !== input.commandId);
    if (other.some(id => repository.commandStatus(id)?.status !== 'rejected')) throw new Error('begin_attempt_unresolved');
    if (!record.commandIds.includes(input.commandId) && this.deps.repository.handoffId(draft) !== null) throw new Error('begin_handoff_exists');
  }
  async recover(raw: LinkedInRevision): ReturnType<LinkedInApi['recover']> {
    this.assertCurrent(); const input = linkedInRevisionSchema.parse(raw);
    const record = this.deps.repository.actionRecord(input.draftId, input.expectedRevision);
    const handoffId = this.deps.repository.handoffId(record.identity);
    const handoff = handoffId === null ? null : this.handoff(record.identity);
    return { draftId: input.draftId, revision: input.expectedRevision, approvalCommandId: record.approvalCommandId,
      attempts: record.commandIds.map(commandId => ({ commandId, receipt: this.owner().repository.commandStatus(commandId) })),
      handoffId, started: handoff?.consumedAt != null };
  }
  async begin(raw: LinkedInBegin): ReturnType<LinkedInApi['begin']> {
    this.assertCurrent(); const input = linkedInBeginSchema.parse(raw);
    const { draft, context } = this.deps.repository.requireAction(input.draftId, input.expectedRevision);
    this.assertNoPending(draft.accountId); validateLinkedInTarget(context.target);
    const owner = this.owner();
    const assertAttempt = () => this.assertBeginAttempt(input);
    const approval = this.deps.repository.approve(input, assertAttempt);
    const command = this.replay(prepareManualCommandSchema.parse({ ...this.envelope(input.commandId, draft), kind: 'prepare-manual', payload: approval.binding }));
    owner.repository.queueCommand(command, assertAttempt);
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
    const { identity: draft } = this.deps.repository.actionRecord(input.draftId, input.expectedRevision);
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

/** C6 supplies its lifetime-checked wrapper around FoundationRuntime.withDatabase.
 * Repositories and owner clients are constructed only inside one operation lease. */
export function createRuntimeLinkedInApi(options: Omit<ConstructorParameters<typeof LinkedInService>[0], 'repository' | 'owner'> & {
  databaseGate: { withDatabase<T>(run: (database: AppDatabase, signal: AbortSignal) => Promise<T>): Promise<T> };
  workspaceId: string;
  clock: { now(): string };
  ownerFactory(database: AppDatabase, signal: AbortSignal): NonNullable<ConstructorParameters<typeof LinkedInService>[0]['owner']>;
}): LinkedInApi {
  const { databaseGate, workspaceId, clock, ownerFactory, ...adapters } = options;
  const draftEnrollment = (database: AppDatabase, input: LinkedInRevision) => {
    const row = database.raw.prepare('SELECT enrollment_id FROM manual_linkedin_drafts WHERE workspace_id=? AND id=?')
      .get(workspaceId, input.draftId) as { enrollment_id: string } | undefined;
    if (!row) throw new Error('draft_missing');
    return row.enrollment_id;
  };
  const run = <Q, R>(schema: z.ZodType<Q>, raw: Q, enrollment: (database: AppDatabase, input: Q) => string,
    operation: (service: LinkedInService, input: Q) => Promise<R>): Promise<R> => databaseGate.withDatabase(async (database, external) => {
    external.throwIfAborted();
    const input = schema.parse(raw);
    const enrollmentId = enrollment(database, input);
    const lifetime = new AbortController();
    const signal = AbortSignal.any([external, lifetime.signal]);
    let service: LinkedInService | undefined;
    const abort = () => service?.dispose();
    try {
      const repository = new LinkedInRepository({ database, workspaceId, enrollmentId, clock });
      const owner = ownerFactory(database, signal);
      service = new LinkedInService({ ...adapters, repository, owner });
      signal.addEventListener('abort', abort, { once: true });
      signal.throwIfAborted();
      const result = await operation(service, input);
      signal.throwIfAborted();
      return result;
    } finally {
      service?.dispose();
      lifetime.abort();
      signal.removeEventListener('abort', abort);
    }
  });
  return {
    prepare: input => run(linkedInPrepareSchema, input, (_database, request) => request.enrollmentId, (service, request) => service.prepare(request)),
    get: input => run(linkedInRevisionSchema, input, draftEnrollment, (service, request) => service.get(request)),
    save: input => run(linkedInSaveSchema, input, (database, request) => draftEnrollment(database, request), (service, request) => service.save(request)),
    copy: input => run(linkedInRevisionSchema, input, draftEnrollment, (service, request) => service.copy(request)),
    open: input => run(linkedInRevisionSchema, input, draftEnrollment, (service, request) => service.open(request)),
    begin: input => run(linkedInBeginSchema, input, (database, request) => draftEnrollment(database, request), (service, request) => service.begin(request)),
    recover: input => run(linkedInRevisionSchema, input, draftEnrollment, (service, request) => service.recover(request)),
    reportOutcome: input => run(linkedInReportSchema, input, (database, request) => draftEnrollment(database, request), (service, request) => service.reportOutcome(request)),
  };
}
