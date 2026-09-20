import { z } from 'zod';
import { instant, uuid } from '@fss/contracts';

/**
 * What the sequence editor window is given, and the nine things it may ask for
 * (specification 11.1, 11.3, 4.3, 14.2).
 *
 * A third contract beside G2's cache shape and G6's Today shape, for the reason G6
 * gave for its own: this state names contacts, template bodies and LinkedIn message
 * text, none of which may be written to the encrypted 24-hour cache (5.3). Keeping it
 * in a type the cache has never heard of makes that structural rather than remembered.
 *
 * Nothing here decides anything. Every field is a shape the API already produced, and
 * the window's whole job is to show it and to disable what cannot be done. In
 * particular:
 *
 *   * `canPublish` is a server fact, not a client computation — the API refuses a
 *     publish whose email step names an unapproved template, and the window shows
 *     *why* rather than deciding for itself;
 *   * the LinkedIn card carries `undoUntil`, and the window compares it with the
 *     *server's* clock reading, which arrives in `asOf`, because a Mac whose clock is
 *     fast must not be able to show an undo button the server would refuse;
 *   * `contentHash` is displayed verbatim, because 11.1 binds an approval to bytes and
 *     an approver ought to be able to read the digest they are approving.
 */

export const STEP_CHANNELS = ['email', 'call_task', 'linkedin_task'] as const;
export type StepChannel = (typeof STEP_CHANNELS)[number];

export const sequenceDelaySchema = z.union([
  z.strictObject({ unit: z.literal('elapsed'), hours: z.number().int().min(0).max(8760) }),
  z.strictObject({ unit: z.literal('business_days'), days: z.number().int().min(0).max(365) }),
]);
export type SequenceDelay = z.infer<typeof sequenceDelaySchema>;

export const sequenceStepSchema = z.strictObject({
  id: uuid,
  ordinal: z.number().int().min(1),
  channel: z.enum(STEP_CHANNELS),
  delay: sequenceDelaySchema,
  onNoAnswer: z.enum(['advance', 'retry_call']).nullable(),
  templateVersionId: uuid.nullable(),
  linkedInMessage: z.string().max(1200).nullable(),
});
export type SequenceStep = z.infer<typeof sequenceStepSchema>;

export const sequenceVersionSchema = z.strictObject({
  id: uuid,
  sequenceId: uuid,
  version: z.number().int().min(1),
  state: z.enum(['draft', 'published', 'retired']),
  stopConditions: z.array(z.string().min(1).max(40)),
  publishedAt: instant.nullable(),
  retiredAt: instant.nullable(),
  steps: z.array(sequenceStepSchema),
});
export type SequenceVersion = z.infer<typeof sequenceVersionSchema>;

export const sequenceSummarySchema = z.strictObject({
  id: uuid,
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable(),
  archivedAt: instant.nullable(),
});
export type SequenceSummary = z.infer<typeof sequenceSummarySchema>;

export const templateVersionSchema = z.strictObject({
  id: uuid,
  templateId: uuid,
  version: z.number().int().min(1),
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(160),
  body: z.string().min(1).max(4000),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  footerSignOff: z.string().min(1).max(300),
  footerPostalAddress: z.string().min(1).max(200),
  requiredVariables: z.array(z.string().min(1).max(60)),
  approvedAt: instant.nullable(),
  retiredAt: instant.nullable(),
  personalizationStrategy: z.string().max(40).nullable(),
});
export type TemplateVersion = z.infer<typeof templateVersionSchema>;

/** One live enrollment on the Firm page's enrollment panel (11.2). */
export const enrollmentSchema = z.strictObject({
  id: uuid,
  sequenceVersionId: uuid,
  firmId: uuid,
  contactId: uuid,
  state: z.enum(['active', 'review_required', 'completed', 'stopped']),
  startedAt: instant,
  endedAt: instant.nullable(),
  endReason: z.string().max(40).nullable(),
  reviewUnionMilliseconds: z.number().int().min(0).nullable(),
});
export type Enrollment = z.infer<typeof enrollmentSchema>;

/**
 * The LinkedIn task card (11.3).
 *
 * `message` is the step's frozen text; `linkedInUrl` is the contact's profile.
 * `undoUntil` is present only while the ten-minute window is open, and the window
 * compares it with `asOf` rather than with `Date.now()`.
 */
export const linkedInCardSchema = z.strictObject({
  stepExecutionId: uuid,
  enrollmentId: uuid,
  contactName: z.string().max(200).nullable(),
  linkedInUrl: z.string().max(400).nullable(),
  message: z.string().min(1).max(1200),
  handedOff: z.boolean(),
  undoUntil: instant.nullable(),
});
export type LinkedInCard = z.infer<typeof linkedInCardSchema>;

export const sequenceStateSchema = z.strictObject({
  online: z.boolean(),
  mayMutate: z.boolean(),
  isAdmin: z.boolean(),
  /** Database time as of the last answer. Every deadline is compared against this. */
  asOf: instant.nullable(),
  sequences: z.array(sequenceSummarySchema),
  selectedSequenceId: uuid.nullable(),
  versions: z.array(sequenceVersionSchema),
  templates: z.array(templateVersionSchema),
  /** Enrollments needing the long-hold review screen (4.3). */
  heldEnrollments: z.array(enrollmentSchema),
  linkedInCard: linkedInCardSchema.nullable(),
  notice: z.string().max(400).nullable(),
});
export type SequenceState = z.infer<typeof sequenceStateSchema>;

export interface SequenceBridge {
  state(): Promise<SequenceState>;
  openSequence(input: { readonly sequenceId: string }): Promise<SequenceState>;
  createSequence(input: { readonly name: string }): Promise<SequenceState>;
  saveDraft(input: {
    readonly sequenceVersionId: string;
    readonly steps: readonly Omit<SequenceStep, 'id'>[];
  }): Promise<SequenceState>;
  publish(input: { readonly sequenceVersionId: string }): Promise<SequenceState>;
  retire(input: { readonly sequenceVersionId: string }): Promise<SequenceState>;
  approveTemplate(input: { readonly templateVersionId: string }): Promise<SequenceState>;
  enroll(input: {
    readonly sequenceVersionId: string;
    readonly opportunityId: string;
    readonly firmId: string;
    readonly contactId: string;
  }): Promise<SequenceState>;
  completeLinkedIn(input: { readonly stepExecutionId: string }): Promise<SequenceState>;
  undoLinkedIn(input: { readonly stepExecutionId: string }): Promise<SequenceState>;
  recordLinkedInResult(input: {
    readonly enrollmentId: string;
    readonly result: 'replied' | 'no_engagement';
  }): Promise<SequenceState>;
  resumeEnrollment(input: { readonly enrollmentId: string }): Promise<SequenceState>;
}

declare global {
  /** The bridge the preload script installs, exactly as G2's `callie` is installed. */
  var callieSequences: SequenceBridge | undefined;
}
