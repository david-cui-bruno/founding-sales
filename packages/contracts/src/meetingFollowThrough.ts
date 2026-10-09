import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';
import { meetingDeadlineSchema, meetingEvidenceSchema } from './meetingOutcomes.ts';
import { commandIdSchema } from './auth.ts';
import { answerBlockSchema } from './outreach.ts';
import { semanticVersionSchema } from './clientVersion.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const meetingFollowThroughScopeSchema = z.strictObject({
  contactId: uuid, meetingId: uuid, bookingReference: z.string().min(1).max(200),
  purposes: z.array(z.enum(['recap', 'nudge', 'reminder'])).min(1).max(3), maxMessages: z.number().int().min(1).max(3),
  expiresAt: instant, agreedReminder: meetingDeadlineSchema.nullable(), reminderEvidence: z.array(meetingEvidenceSchema).max(20),
});
export type MeetingFollowThroughScope = z.infer<typeof meetingFollowThroughScopeSchema>;
export const meetingRecapDraftSchema = z.strictObject({
  id: uuid, version: z.number().int().positive(), ordinal: z.number().int().min(1).max(3),
  subject: z.string().min(1).max(998), body: z.string().min(1).max(4000), renderedHash: hash,
  templateVersionId: uuid, sourceHash: hash, materialReferences: z.array(z.string().url()).max(20),
  createdAt: instant, notBefore: instant,
  state: z.enum(['ready', 'held', 'editing', 'cancelled', 'superseded', 'submitted', 'sent']),
});
export type MeetingRecapDraft = z.infer<typeof meetingRecapDraftSchema>;
export const meetingFollowThroughViewSchema = z.strictObject({
  meetingId: uuid, firmId: uuid, contactId: uuid.nullable(), planId: uuid.nullable(), version: z.number().int().nonnegative(),
  sourceHash: hash, notesRevision: z.number().int().nonnegative(), sequenceVersionId: uuid.nullable(),
  status: z.enum(['draft', 'held', 'scheduled', 'awaiting_reply', 'completed', 'cancelled', 'needs_review']),
  currentDraft: meetingRecapDraftSchema.nullable(), scope: meetingFollowThroughScopeSchema.nullable(),
  blockers: z.array(z.string().max(100)).max(30), sendingPaused: z.boolean(),
  plannedSteps: z.array(z.strictObject({ ordinal: z.number().int().min(1).max(3), dueAt: instant.nullable(), state: z.string().max(30) })).max(3),
  sentMessages: z.array(z.strictObject({ messageId: uuid, ordinal: z.number().int().min(1).max(3), sentAt: instant })).max(3),
});
export type MeetingFollowThroughView = z.infer<typeof meetingFollowThroughViewSchema>;
export const meetingFollowThroughViewV2Schema=meetingFollowThroughViewSchema.extend({approvalHash:hash.nullable().optional(),approvalRequired:z.boolean().optional(),approvedAt:instant.nullable().optional(),facts:z.array(answerBlockSchema).max(20).optional(),plannedMessages:z.array(z.strictObject({ordinal:z.number().int().min(1).max(3),subject:z.string().max(998),body:z.string().max(4000)})).max(3).optional()});
export type MeetingFollowThroughViewV2=z.infer<typeof meetingFollowThroughViewV2Schema>;
const editBase = { planId: uuid, expectedPlanVersion: z.number().int().positive(), expectedDraftVersion: z.number().int().positive() };
export const meetingDraftEditSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...editBase, action: z.literal('begin_edit') }),
  z.strictObject({ ...editBase, action: z.literal('save'), subject: z.string().trim().min(1).max(998).refine(s => !/[\r\n]/u.test(s)), body: z.string().trim().min(1).max(4000) }),
  z.strictObject({ ...editBase, action: z.literal('discard') }),
  z.strictObject({ ...editBase, action: z.literal('cancel') }),
  z.strictObject({ ...editBase, action: z.literal('approve'),expectedApprovalHash:hash }),
]);
export type MeetingDraftEdit = z.infer<typeof meetingDraftEditSchema>;
const commandEnvelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };
export const meetingDraftEditCommandSchema = z.discriminatedUnion('action', [
  meetingDraftEditSchema.options[0].extend(commandEnvelope), meetingDraftEditSchema.options[1].extend(commandEnvelope),
  meetingDraftEditSchema.options[2].extend(commandEnvelope), meetingDraftEditSchema.options[3].extend(commandEnvelope),
  meetingDraftEditSchema.options[4].extend(commandEnvelope),
]);
