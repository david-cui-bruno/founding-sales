import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { campaignRevisionSchema as revision, stepEvidenceSchema } from './campaignContract';
import { commandReceiptSchema } from './commandReceiptContract';
import { prepareManualCommandSchema, completeManualCommandSchema, manualHandoffSchema, manualOutcomeSchema } from './ownerCommandContract';
import { originalCallRefSchema } from './requestedFollowupContract';

export const PHONE_STATE_MAX_PREPARES = 32;
export const PHONE_STATE_MAX_COMPLETIONS = 100;
export const delegatedPhoneStateRequestSchema = z.strictObject({ accountId: id, enrollmentId: id, stepId: id });
export type GetPhoneHandoffStateRequest = z.infer<typeof delegatedPhoneStateRequestSchema>;
const callOutcome = manualOutcomeSchema.options[0];
const prepare = prepareManualCommandSchema.extend({ payload: prepareManualCommandSchema.shape.payload.extend({ channel: z.literal('call') }) });
const complete = completeManualCommandSchema.extend({ payload: completeManualCommandSchema.shape.payload.extend({ outcome: callOutcome }) });
const handoff = manualHandoffSchema.extend({ channel: z.literal('call') });
const evidence = stepEvidenceSchema.omit({ cancellationEvidence: true }).extend({ channel: z.literal('call'), source: z.literal('human'),
  observation: z.literal('unknown'), state: z.enum(['unknown', 'human_reported_sent', 'cancelled']), outcome: callOutcome.shape.outcome });
const receiptEvent = z.strictObject({ eventId: id, kind: z.enum(['manual.handoff', 'manual.outcome', 'authority.changed']),
  authorityGeneration: revision, aggregateVersion: revision.positive(), appliedAt: instant });
const prepareRecord = z.strictObject({ command: prepare, queuedAt: instant, receipt: commandReceiptSchema, receiptEvent: receiptEvent.nullable(),
  handoff: z.strictObject({ value: handoff, authorityGeneration: revision, consumedAt: instant.nullable() }).nullable() });
const completionRecord = z.strictObject({ prepareCommandId: z.uuid(), command: complete, queuedAt: instant, receipt: commandReceiptSchema,
  receiptEvent: receiptEvent.nullable(), applied: z.strictObject({ outcome: callOutcome, campaignCommandId: z.uuid(), evidence, originalCall: originalCallRefSchema.optional() }).nullable() });
const scope = { ...delegatedPhoneStateRequestSchema.shape, workspaceId: id,
  campaign: z.strictObject({ campaignId: id, campaignRevision: revision.positive(), campaignVersionId: id }), generatedAt: instant, remote: z.literal('unknown') };
const shape = z.discriminatedUnion('completeness', [
  z.strictObject({ ...scope, completeness: z.literal('complete'), issue: z.null(), attempts: z.array(prepareRecord).max(PHONE_STATE_MAX_PREPARES), completions: z.array(completionRecord).max(PHONE_STATE_MAX_COMPLETIONS) }),
  z.strictObject({ ...scope, completeness: z.literal('incomplete'), issue: z.enum(['source_limit', 'prepare_limit', 'completion_limit', 'invalid_record', 'ambiguous_identity']), attempts: z.array(z.never()).length(0), completions: z.array(z.never()).length(0) }),
]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const compare = (a: { queuedAt: string; command: { commandId: string } }, b: { queuedAt: string; command: { commandId: string } }) =>
  a.queuedAt < b.queuedAt || a.queuedAt === b.queuedAt && a.command.commandId < b.command.commandId;
export const delegatedPhoneStateSchema = shape.superRefine((value, ctx) => {
  const check = (valid: boolean) => { if (!valid) ctx.addIssue({ code: 'custom', message: 'Phone history correspondence mismatch' }); };
  check(new TextEncoder().encode(JSON.stringify(value)).byteLength <= 8_388_608);
  if (value.completeness !== 'complete') return;
  const commands = new Set<string>(), events = new Set<string>(), handoffs = new Set<string>(), actions = new Set<string>();
  const unique = (set: Set<string>, key: string) => { if (set.has(key)) ctx.addIssue({ code: 'custom', message: 'Phone history ambiguous identity' }); set.add(key); };
  for (const records of [value.attempts, value.completions]) {
    for (let i = 1; i < records.length; i++) check(compare(records[i - 1], records[i]));
    for (const record of records) {
      const { command, receipt, receiptEvent: event } = record;
      unique(commands, command.commandId);
      check(command.accountId === value.accountId && command.workspaceId === value.workspaceId && receipt.commandId === command.commandId && record.queuedAt <= value.generatedAt);
      if (event) {
        unique(events, event.eventId);
        check(event.authorityGeneration === receipt.authorityGeneration && event.aggregateVersion === receipt.aggregateVersion && event.appliedAt >= record.queuedAt && event.appliedAt <= value.generatedAt);
        check(receipt.status === 'rejected' ? event.kind === 'authority.changed' : receipt.status === 'applied' && event.kind === (command.kind === 'prepare-manual' ? 'manual.handoff' : 'manual.outcome'));
      } else check(receipt.status === 'pending' || receipt.status === 'rejected');
    }
  }
  for (const record of value.attempts) {
    const { command, handoff: saved, receiptEvent: event } = record, binding = command.payload;
    unique(actions, binding.actionId);
    check(binding.campaign.enrollmentId === value.enrollmentId && binding.campaign.stepId === value.stepId && binding.campaign.campaignId === value.campaign.campaignId && binding.campaign.campaignRevision === value.campaign.campaignRevision);
    check((record.receipt.status === 'applied') === (saved !== null));
    if (!saved) continue;
    unique(handoffs, saved.value.handoffId);
    check(same(saved.value, { ...binding, handoffId: saved.value.handoffId, expiresAt: saved.value.expiresAt }));
    check(event !== null && saved.authorityGeneration === event.authorityGeneration && saved.authorityGeneration === command.expectedAuthorityGeneration && event.aggregateVersion === command.expectedVersion + 1);
    if (saved.consumedAt !== null) check(event !== null && event.appliedAt <= saved.consumedAt && saved.consumedAt < saved.value.expiresAt && saved.consumedAt <= value.generatedAt);
  }
  for (const record of value.completions) {
    const parents = value.attempts.filter(p => p.command.commandId === record.prepareCommandId);
    check(parents.length === 1);
    const parent = parents[0], saved = parent?.handoff, p = record.command.payload, outcome = p.outcome;
    check(!!saved && saved.consumedAt !== null);
    if (!saved || saved.consumedAt === null) continue;
    check(p.handoffId === saved.value.handoffId && p.targetHash === saved.value.targetHash && outcome.actionId === saved.value.actionId && outcome.channel === saved.value.channel);
    check(outcome.observedAt >= saved.consumedAt && outcome.observedAt <= value.generatedAt);
    check((record.receipt.status === 'applied') === (record.applied !== null));
    if (!record.applied) continue;
    check(record.command.expectedAuthorityGeneration >= saved.authorityGeneration);
    const applied = record.applied, e = applied.evidence, event = record.receiptEvent;
    if (applied.originalCall) {
      const ref = applied.originalCall;
      check(outcome.outcome === 'connected' && !e.conflict && ref.commandId === record.command.commandId
        && ref.handoffId === saved.value.handoffId && ref.actionId === outcome.actionId && ref.outcomeEventId === event?.eventId);
      check(!value.completions.some(other => other.applied && (other.applied.evidence.conflict || other.applied.outcome.outcome === 'opt_out')));
    }
    check(same(applied.outcome, outcome) && applied.campaignCommandId === record.command.commandId);
    check(event !== null && event.authorityGeneration === saved.authorityGeneration && event.aggregateVersion > record.command.expectedVersion && event.aggregateVersion > (parent.receiptEvent?.aggregateVersion ?? Infinity) && event.appliedAt >= outcome.observedAt);
    check(e.accountId === value.accountId && e.enrollmentId === value.enrollmentId && e.stepId === value.stepId && e.campaignVersionId === value.campaign.campaignVersionId && e.actionId === outcome.actionId && e.routeId === saved.value.routeId && e.routeVersion === saved.value.routeVersion && e.executionContextId === saved.value.contextRevision && e.outcome === outcome.outcome && e.observedAt === outcome.observedAt);
    check(outcome.outcome === 'opt_out' ? e.state === 'unknown' || e.state === 'human_reported_sent' : e.state === (outcome.outcome === 'unknown' ? 'unknown' : ['not_called', 'cancelled'].includes(outcome.outcome) ? 'cancelled' : 'human_reported_sent'));
  }
});
export type PhoneHandoffState = z.infer<typeof delegatedPhoneStateSchema>;
export function delegatedPhoneStateReplySchema(raw: GetPhoneHandoffStateRequest) {
  const request = Object.freeze(delegatedPhoneStateRequestSchema.parse(raw));
  return delegatedPhoneStateSchema.refine(value => value.accountId === request.accountId && value.enrollmentId === request.enrollmentId && value.stepId === request.stepId, 'Phone selector mismatch');
}
