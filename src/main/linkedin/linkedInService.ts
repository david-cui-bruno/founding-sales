import type { ActionState } from '../../shared/contracts/delegationContract';
import { linkedInPrepareSchema, linkedInRevisionSchema, linkedInReportSchema, type LinkedInApi, type LinkedInPrepare, type LinkedInSave, type LinkedInRevision, type LinkedInReport } from '../../shared/contracts/linkedInContract';
import { approvedLinkedInFactsSchema, type ApprovedLinkedInFacts, type LinkedInDraftProvider } from './linkedInDraftProvider';
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
  constructor(private readonly deps: { repository: LinkedInRepository; provider?: LinkedInDraftProvider; productFacts?: ApprovedLinkedInFacts; shell?: { openExternal(url: string): Promise<void> }; clipboard?: { writeText(text: string): Promise<void> | void } }) {}
  dispose() { this.lifetime.abort(); }
  private assertCurrent() { if (this.lifetime.signal.aborted) throw new Error('linkedin_disposed'); }
  async prepare(raw: LinkedInPrepare) {
    this.assertCurrent(); const input = linkedInPrepareSchema.parse(raw);
    const context = this.deps.repository.requireStep(input.stepId, input.expectedVersion);
    validateLinkedInTarget(context.target);
    const existing = this.deps.repository.find(context); if (existing) return existing;
    if (!this.deps.provider || !this.deps.productFacts) throw new Error('provider_unconfigured');
    const product = approvedLinkedInFactsSchema.parse(this.deps.productFacts);
    const source = this.deps.repository.generationContext(context);
    const generated = await this.deps.provider.generate({ ...source, facts: [...source.facts, ...product.facts], productApprovalId: product.approvalId }, this.lifetime.signal);
    this.assertCurrent();
    return this.deps.repository.create(context, generated.body);
  }
  async save(input: LinkedInSave) { this.assertCurrent(); return this.deps.repository.save(input); }
  async get(raw: LinkedInRevision) { this.assertCurrent(); const input = linkedInRevisionSchema.parse(raw); return this.deps.repository.requireRevision(input.draftId, input.expectedRevision); }
  async open(raw: LinkedInRevision) {
    this.assertCurrent(); const input = linkedInRevisionSchema.parse(raw); const { draft, context } = this.deps.repository.requireAction(input.draftId, input.expectedRevision);
    const target = validateLinkedInTarget(context.target);
    if (!this.deps.shell) throw new Error('shell_unconfigured');
    await this.deps.shell.openExternal(target);
    return { draftId: draft.id, revision: draft.revision, status: 'opened' as const };
  }
  async copy(raw: LinkedInRevision) {
    this.assertCurrent(); const input = linkedInRevisionSchema.parse(raw); const { draft } = this.deps.repository.requireAction(input.draftId, input.expectedRevision);
    if (!this.deps.clipboard) throw new Error('clipboard_unconfigured');
    await this.deps.clipboard.writeText(draft.body);
    return { draftId: draft.id, revision: draft.revision, status: 'copied' as const };
  }
  async reportOutcome(raw: LinkedInReport): ReturnType<LinkedInApi['reportOutcome']> {
    this.assertCurrent(); const input = linkedInReportSchema.parse(raw); this.deps.repository.requireRevision(input.draftId, input.expectedRevision);
    throw new Error('owner_protocol_unconfigured');
  }
}
