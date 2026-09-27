import { z } from 'zod';
import {
  STEP_CHANNELS,
  STEP_NO_ANSWER_ACTIONS,
  enrollmentDtoSchema,
  sequenceDelaySchema,
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
/**
 * One enrollment: a contact working through a version of a sequence (11.2).
 *
 * Read-only here. Since wave 2 there is nothing to confirm about one — an enrollment
 * held a long time resumes on its own (S4.1) — so the Sequences view lists who is in
 * flight and leaves it at that.
 */
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
 * One step as the editor holds it and as it is sent (lane g88, audit G03).
 *
 * No ordinal: a step's number is its place in the list, assigned when it is saved, so a
 * reorder can never leave the gap `publishVersion` refuses.
 */
export const draftStepSchema = z.strictObject({
  channel: z.enum(STEP_CHANNELS),
  delay: sequenceDelaySchema,
  onNoAnswer: z.enum(STEP_NO_ANSWER_ACTIONS).nullable(),
  templateVersionId: uuid.nullable(),
});
export type DraftStep = z.infer<typeof draftStepSchema>;

/**
 * A template version as the form writes it (lane g88; wave 2, S3).
 *
 * `body` is what the person typed; the sign-off and the stop line are appended by the
 * bridge, so the footer 12.6 requires is always the last thing in the email and never
 * something the person had to type. `templateVersionId` names the version being edited
 * **in place** — since wave 2 a version is edited rather than superseded, and the same
 * command approves it, so writing and approving are one press.
 */
export interface TemplateDraft {
  /** The version being edited in place, or null for a new template. */
  readonly templateVersionId: string | null;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly signOff: string;
}

export const sequenceStateSchema = z.strictObject({
  online: z.boolean(),
  mayMutate: z.boolean(),
  isAdmin: z.boolean(),
  sequences: z.array(sequenceSummaryDtoSchema),
  selectedSequenceId: uuid.nullable(),
  versions: z.array(sequenceVersionDtoSchema),
  templates: z.array(templateVersionDtoSchema),
  /** Everyone in flight, in any sequence; the view shows the chosen sequence's own. */
  enrollments: z.array(enrollmentDtoSchema),
  /** One per slice: the refusal code of the read that filled it, or null. */
  readErrors: z.strictObject({
    sequences: readErrorSchema,
    versions: readErrorSchema,
    templates: readErrorSchema,
    enrollments: readErrorSchema,
  }),
  notice: z.string().max(400).nullable(),
  /**
   * The copy warnings the last template create or approval answered (wave 1): codes such
   * as `template_body_too_long`, which warn and no longer refuse. Strings, not an enum,
   * so a code added later is still shown rather than refused. Empty after any other act.
   */
  warnings: z.array(z.string().min(1).max(80)).max(20),
});
export type SequenceState = z.infer<typeof sequenceStateSchema>;

/**
 * The long-hold review went with the seven-day review itself (wave 2, S4.1): an
 * enrollment held that long resumes on its own, `review_required` is never sent, and
 * neither `/enrollments/resume/preview` nor `/enrollments/resume` has a caller here.
 */
