import { z } from 'zod';
import {
  enrollmentDtoSchema,
  instant,
  sequenceSummaryDtoSchema,
  sequenceVersionDtoSchema,
  templateVersionDtoSchema,
  uuid,
  type EnrollmentDto,
  type SequenceDelay as SequenceDelayDto,
  type SequenceStepDto,
  type SequenceSummaryDto,
  type SequenceVersionDto,
  type TemplateVersionDto,
} from '@fss/contracts';

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

/*
 * The wire shapes are `@fss/contracts`' (`packages/contracts/src/sequences.ts`), and
 * this file only names them for the window (lane g78). Until then it declared its own
 * copies, strict, and they had drifted: the step schema forbade `sequenceVersionId`,
 * which the API puts on every step, and the enrollment schema did not know four fields
 * the API always sends. Every populated version and every populated enrollment list
 * failed to parse, and the window showed empty lists as though there were none (D01,
 * D02, D06). A copy here would be the same defect waiting for the next field.
 */
export { STEP_CHANNELS, type StepChannel } from '@fss/contracts';
export type SequenceDelay = SequenceDelayDto;
export type SequenceStep = SequenceStepDto;
export type SequenceVersion = SequenceVersionDto;
export type SequenceSummary = SequenceSummaryDto;
export type TemplateVersion = TemplateVersionDto;
/** One enrollment, as the Firm page's enrollment panel and the hold review read it (11.2). */
export type Enrollment = EnrollmentDto;

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

/**
 * Why one slice of the window could not be read, or null when it was (lane g78, D06).
 *
 * The refusal code, exactly as the bridge got it. A slice that failed is empty *and*
 * says so: an empty list with no error is "there are none", an empty list with an
 * error is "Callie could not ask", and the window renders the two differently, the way
 * Administration's sending section does since lane g69.
 */
const readErrorSchema = z.string().min(1).max(80).nullable();

export const SEQUENCE_READ_SLICES = ['sequences', 'versions', 'templates', 'enrollments'] as const;
export type SequenceReadSlice = (typeof SEQUENCE_READ_SLICES)[number];

export const sequenceStateSchema = z.strictObject({
  online: z.boolean(),
  mayMutate: z.boolean(),
  isAdmin: z.boolean(),
  /** Database time as of the last answer. Every deadline is compared against this. */
  asOf: instant.nullable(),
  sequences: z.array(sequenceSummaryDtoSchema),
  selectedSequenceId: uuid.nullable(),
  versions: z.array(sequenceVersionDtoSchema),
  templates: z.array(templateVersionDtoSchema),
  /** Enrollments needing the long-hold review screen (4.3). */
  heldEnrollments: z.array(enrollmentDtoSchema),
  /** One per slice: the refusal code of the read that filled it, or null. */
  readErrors: z.strictObject({
    sequences: readErrorSchema,
    versions: readErrorSchema,
    templates: readErrorSchema,
    enrollments: readErrorSchema,
  }),
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
    readonly steps: readonly Omit<SequenceStep, 'id' | 'sequenceVersionId'>[];
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
