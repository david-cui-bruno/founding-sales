import { z } from 'zod';
import {
  STEP_CHANNELS,
  STEP_NO_ANSWER_ACTIONS,
  enrollmentDtoSchema,
  instant,
  resumePreviewSchema,
  sequenceDelaySchema,
  sequenceSummaryDtoSchema,
  sequenceVersionDtoSchema,
  templateVersionDtoSchema,
  uuid,
  type EnrollmentDto,
  type ResumePreviewDto,
  type SequenceDelay as SequenceDelayDto,
  type SequenceStepDto,
  type SequenceSummaryDto,
  type SequenceVersionDto,
  type TemplateVersionDto,
} from '@fss/contracts';

/**
 * What the sequence editor window is given, and the things it may ask for
 * (specification 11.1, 4.3, 14.2).
 *
 * A third contract beside G2's cache shape and G6's Today shape, for the reason G6
 * gave for its own: this state names contacts and template bodies, neither of which
 * may be written to the encrypted 24-hour cache (5.3). Keeping it in a type the cache
 * has never heard of makes that structural rather than remembered.
 *
 * Nothing here decides anything. Every field is a shape the API already produced, and
 * the window's whole job is to show it and to disable what cannot be done. In
 * particular:
 *
 *   * `canPublish` is a server fact, not a client computation — the API refuses a
 *     publish whose email step names an unapproved template, and the window shows
 *     *why* rather than deciding for itself;
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

/**
 * One step of a draft, as the editor holds it and as it is sent (lane g88, audit G03).
 *
 * No ordinal: a step's number is its place in the list, assigned when the draft is saved,
 * so a reorder can never leave the gap `publishVersion` refuses.
 */
export const draftStepSchema = z.strictObject({
  channel: z.enum(STEP_CHANNELS),
  delay: sequenceDelaySchema,
  onNoAnswer: z.enum(STEP_NO_ANSWER_ACTIONS).nullable(),
  templateVersionId: uuid.nullable(),
});
export type DraftStep = z.infer<typeof draftStepSchema>;

/**
 * A template version as the form writes it (lane g88). `body` is what the person typed;
 * the sign-off and the stop line are appended by the bridge, so the footer 12.6 requires
 * is always the last thing in the email and never something the person had to type.
 */
export interface TemplateDraft {
  /** The template this is a new version of, or null for a new template. */
  readonly templateId: string | null;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly signOff: string;
}

/**
 * What "Review and resume" shows (lane g88, audit G06): the server's preview of the
 * resume, and the database time it was computed at. Present only while the person is
 * looking at it; the confirmation is the one action it offers.
 */
export const resumeReviewSchema = z.strictObject({
  asOf: instant,
  preview: resumePreviewSchema,
});
export type ResumeReview = z.infer<typeof resumeReviewSchema>;
export type ResumePreview = ResumePreviewDto;

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
  /** The resume review the person opened, or null (lane g88). */
  resumeReview: resumeReviewSchema.nullable(),
  notice: z.string().max(400).nullable(),
});
export type SequenceState = z.infer<typeof sequenceStateSchema>;

export interface SequenceBridge {
  state(): Promise<SequenceState>;
  openSequence(input: { readonly sequenceId: string }): Promise<SequenceState>;
  /** Lane g88: creates the sequence and its first, empty draft, and opens it. */
  createSequence(input: { readonly name: string }): Promise<SequenceState>;
  /** Lane g88: a new draft of a published sequence, copying its newest published steps. */
  createDraft(input: { readonly sequenceId: string }): Promise<SequenceState>;
  saveDraft(input: { readonly sequenceVersionId: string; readonly steps: readonly DraftStep[] }): Promise<SequenceState>;
  /** Lane g88: writes an unapproved template version. Approval stays its own act. */
  createTemplate(input: TemplateDraft): Promise<SequenceState>;
  publish(input: { readonly sequenceVersionId: string }): Promise<SequenceState>;
  retire(input: { readonly sequenceVersionId: string }): Promise<SequenceState>;
  approveTemplate(input: { readonly templateVersionId: string }): Promise<SequenceState>;
  enroll(input: {
    readonly sequenceVersionId: string;
    readonly opportunityId: string;
    readonly firmId: string;
    readonly contactId: string;
  }): Promise<SequenceState>;
  /** Lane g88: read the resume review for one held enrollment. */
  reviewEnrollment(input: { readonly enrollmentId: string }): Promise<SequenceState>;
  closeReview(): Promise<SequenceState>;
  /**
   * The confirmation. Since lane g88 it resumes only the enrollment whose review is on
   * screen; asked for any other, it opens that one's review instead.
   */
  resumeEnrollment(input: { readonly enrollmentId: string }): Promise<SequenceState>;
}

declare global {
  /** The bridge the preload script installs, exactly as G2's `callie` is installed. */
  var callieSequences: SequenceBridge | undefined;
}
