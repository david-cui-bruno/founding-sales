import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant, accountRouteSchema } from './accountContract';
import { requestedFollowupDraftSchema, originalCallRefSchema, type RequestedFollowupDraft } from './requestedFollowupContract';

const text = z.string().min(1).max(2000).refine(v => v.trim().length > 0 && !v.includes('\0'));
const evidenceIds = z.array(id).min(1).max(100).refine(v => new Set(v).size === v.length);
export const displayIssueSchema = z.strictObject({ field: z.enum(['contact', 'role', 'call_context', 'call_note', 'call_contact']),
  reason: z.enum(['not_recorded', 'source_unavailable', 'invalid_source', 'binding_mismatch', 'deleted_person', 'ambiguous']) });
export const displayRoleSchema = z.strictObject({ linkId: id, value: text, validFrom: instant, validTo: instant.nullable(), evidenceIds })
  .refine(v => v.validTo === null || v.validTo > v.validFrom);
export const displayContactSchema = z.strictObject({ basis: z.enum(['recipient_route', 'manual_route', 'original_call_route']), personId: id,
  personVersion: z.number().int().positive().safe(), displayName: text, route: accountRouteSchema, role: displayRoleSchema.nullable() })
  .refine(c => c.personId === c.route.personId);
export type DisplayContact = z.infer<typeof displayContactSchema>;
export type DisplayIssue = z.infer<typeof displayIssueSchema>;
export const requestedDisplayBindingSchema = z.strictObject({ ...requestedFollowupDraftSchema.shape, workspaceId: id })
  .omit({ revision: true, subject: true, body: true, evidenceIds: true, generation: true, updatedAt: true });
const issues = z.array(displayIssueSchema).max(8).refine(v => new Set(v.map(i => `${i.field}:${i.reason}`)).size === v.length);
const callContextSchema = z.strictObject({ basis: z.literal('human_reported_call_outcome'), originalCall: originalCallRefSchema,
  outcome: z.literal('connected'), observedAt: instant, noteText: z.string().min(1).max(10000).refine(v => v.trim().length > 0 && !v.includes('\0')).nullable(), linkedContact: displayContactSchema.nullable() });
function equal(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)])) : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function roleCurrent(contact: DisplayContact | null, asOf: string): boolean {
  return !contact?.role || contact.role.validFrom <= asOf && (contact.role.validTo === null || contact.role.validTo > asOf);
}
export const requestedAnswerPresentationSchema = z.strictObject({ kind: z.literal('requested_followup'), asOf: instant, binding: requestedDisplayBindingSchema,
  contact: displayContactSchema.nullable(), callContext: callContextSchema.nullable(), issues }).refine(p => {
  const b = p.binding, c = p.contact, r = c?.route, call = p.callContext;
  return b.recipient === b.recipientBinding.email
    && (b.recipientBinding.kind !== 'owner_supplied' || c === null && equal(b.originalCall, b.recipientBinding.originalCall))
    && (!c || b.recipientBinding.kind === 'account_route' && c.basis === 'recipient_route' && r!.accountId === b.accountId
      && r!.id === b.recipientBinding.routeId && r!.version === b.recipientBinding.routeVersion && r!.channel === 'email'
      && r!.value === b.recipient && r!.purpose === 'business' && ['published', 'confirmed'].includes(r!.verification))
    && roleCurrent(c, p.asOf) && (!call || equal(call.originalCall, b.originalCall) && call.observedAt <= p.asOf
      && (!call.linkedContact || call.linkedContact.basis === 'original_call_route' && call.linkedContact.route.accountId === b.accountId && call.linkedContact.route.channel === 'phone')
      && roleCurrent(call.linkedContact, p.asOf));
});
export type RequestedAnswerPresentation = z.infer<typeof requestedAnswerPresentationSchema>;
/** Display identity only. This does not authorize any operation or require a text revision. */
export function dailyAnswerPresentationMatches(presentation: unknown, draft: RequestedFollowupDraft, workspaceId: string): boolean {
  const p = requestedAnswerPresentationSchema.safeParse(presentation), d = requestedFollowupDraftSchema.safeParse(draft);
  if (!p.success || !d.success) return false;
  const { revision, subject, body, evidenceIds, generation, updatedAt, ...binding } = d.data;
  void [revision, subject, body, evidenceIds, generation, updatedAt];
  return equal(p.data.binding, { ...binding, workspaceId });
}
