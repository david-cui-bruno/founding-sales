import { z } from 'zod';
import {
  enrollmentsResponseSchema,
  resumePreviewResponseSchema,
  sequenceVersionsResponseSchema,
  sequencesResponseSchema,
  templateVersionsResponseSchema,
  uuid,
} from '@fss/contracts';
import {
  draftStepSchema,
  type DraftStep,
  type ResumeReview,
  type SequenceState,
  type TemplateDraft,
} from '../renderer/sequenceContract.ts';
import {
  EMPTY_SEQUENCE_STATE,
  composeTemplateBody,
  stepsForWire,
  templateFormIssues,
  templateVariablesIn,
} from '../renderer/sequenceView.ts';
import type { AuthedClient } from './authedClient.ts';

/**
 * The sequence editor's half of the bridge, in the main process (specification 11.1,
 * 4.3, 14.2).
 *
 * The window sees a `SequenceState` and nothing else: no access token, no command id.
 * `asOf` carries database time into the state, so every deadline the window shows is
 * the server's. Nothing in this file imports `electron`, and the whole bridge is
 * testable without a window.
 *
 * The LinkedIn handoff — its clipboard copy, profile open, undo and recorded result —
 * went with LinkedIn on 25 September 2026.
 */

export const SEQUENCE_IPC_CHANNELS = {
  state: 'callie:sequences:state',
  openSequence: 'callie:sequences:open',
  createSequence: 'callie:sequences:create',
  // Lane g88: a draft of a published sequence, a new template version, the resume review.
  createDraft: 'callie:sequences:create-draft',
  saveDraft: 'callie:sequences:draft',
  createTemplate: 'callie:sequences:create-template',
  reviewEnrollment: 'callie:sequences:review',
  closeReview: 'callie:sequences:review-close',
  publish: 'callie:sequences:publish',
  retire: 'callie:sequences:retire',
  approveTemplate: 'callie:sequences:approve-template',
  enroll: 'callie:sequences:enroll',
  resumeEnrollment: 'callie:sequences:resume',
} as const;
export type SequenceIpcChannel = (typeof SEQUENCE_IPC_CHANNELS)[keyof typeof SEQUENCE_IPC_CHANNELS];

/*
 * Every answer is parsed with `@fss/contracts`' schema for its route (lane g78), the one
 * the route's own test holds the real answer to. The window's projection — which
 * enrollments are held — is made below, from a parse that already agrees with the
 * server.
 */

export interface SequenceBridgeDeps {
  readonly api: AuthedClient;
  readonly session: {
    state(): Promise<{
      readonly online: boolean;
      readonly mayMutate: boolean;
      readonly device: { readonly role: 'admin' | 'salesperson' } | null;
    }>;
  };
}

export interface SequenceBridgeHost {
  state(): Promise<SequenceState>;
  openSequence(input: { readonly sequenceId: string }): Promise<SequenceState>;
  createSequence(input: { readonly name: string }): Promise<SequenceState>;
  createDraft(input: { readonly sequenceId: string }): Promise<SequenceState>;
  saveDraft(input: { readonly sequenceVersionId: string; readonly steps: unknown }): Promise<SequenceState>;
  createTemplate(input: TemplateDraft): Promise<SequenceState>;
  reviewEnrollment(input: { readonly enrollmentId: string }): Promise<SequenceState>;
  closeReview(): Promise<SequenceState>;
  publish(input: { readonly sequenceVersionId: string }): Promise<SequenceState>;
  retire(input: { readonly sequenceVersionId: string }): Promise<SequenceState>;
  approveTemplate(input: { readonly templateVersionId: string }): Promise<SequenceState>;
  enroll(input: {
    readonly sequenceVersionId: string;
    readonly opportunityId: string;
    readonly firmId: string;
    readonly contactId: string;
  }): Promise<SequenceState>;
  resumeEnrollment(input: { readonly enrollmentId: string }): Promise<SequenceState>;
}

/** What `/sequences/create` and `/sequences/versions/draft` answer, as far as the bridge reads them. */
const createdSequenceSchema = z.object({ id: uuid });
const createdDraftSchema = z.object({ sequenceVersionId: uuid });
/** A refused approval's body: `template_unapproved:` and every issue (`apps/api/src/routes/templates.ts`). */
const refusalReasonSchema = z.object({ reason: z.string().min(1) });
const draftStepsSchema = z.array(draftStepSchema).max(50);

/** The longest notice the window's state may carry. A refused approval's issues are cut to it. */
const NOTICE_LIMIT = 400;

export function createSequenceBridge(deps: SequenceBridgeDeps): SequenceBridgeHost {
  let selectedSequenceId: string | null = null;
  let notice: string | null = null;
  /** The resume review on screen (lane g88), or null. Only its enrollment may be resumed. */
  let resumeReview: ResumeReview | null = null;

  /**
   * Read everything the window shows, in one pass.
   *
   * A refusal on any one read leaves that part empty rather than throwing: 4.2's
   * rule is that the client shows what it has and fails mutations closed, and a
   * window that went blank because one list was unavailable would be worse than one
   * that shows three of four.
   *
   * Empty is not the same as unavailable, though (lane g78, D06). Until g78 a failed
   * read became an empty list and nothing else, so every version and enrollment
   * list the Mac could not parse looked exactly like a workspace with none. Each
   * slice now carries its read's refusal code in `readErrors`, and the window says
   * it could not read that part, with Retry, instead of drawing an empty list.
   */
  const compose = async (): Promise<SequenceState> => {
    const session = await deps.session.state();
    const isAdmin = session.device?.role === 'admin';
    // Always asked, even when the session last found the server away (wave 1). Until
    // then an offline session skipped the reads, so nothing here could find out the
    // connection was back and the view stayed empty until Home refreshed.
    const sequences = await deps.api.read('/sequences', value => sequencesResponseSchema.parse(value));
    if (!sequences.ok && sequences.offline) {
      return { ...EMPTY_SEQUENCE_STATE, isAdmin, mayMutate: session.mayMutate, notice, resumeReview: null };
    }
    const list = sequences.ok ? sequences.value.sequences : [];
    const chosen = selectedSequenceId ?? list[0]?.id ?? null;

    const versions =
      chosen === null
        ? null
        : await deps.api.read('/sequences/versions', value => sequenceVersionsResponseSchema.parse(value), {
            sequenceId: chosen,
          });
    const templates = await deps.api.read('/templates', value => templateVersionsResponseSchema.parse(value), {});
    const enrollments = await deps.api.read('/enrollments', value => enrollmentsResponseSchema.parse(value), {});

    return {
      online: true,
      mayMutate: session.mayMutate,
      isAdmin,
      // Database time, from the API. Never this Mac's clock.
      asOf: enrollments.ok ? enrollments.value.asOf : null,
      sequences: list,
      selectedSequenceId: chosen,
      versions: versions !== null && versions.ok ? versions.value.versions : [],
      templates: templates.ok ? templates.value.templates : [],
      heldEnrollments: enrollments.ok
        ? enrollments.value.enrollments.filter(entry => entry.state === 'review_required')
        : [],
      readErrors: {
        sequences: sequences.ok ? null : sequences.reason,
        versions: versions === null || versions.ok ? null : versions.reason,
        templates: templates.ok ? null : templates.reason,
        enrollments: enrollments.ok ? null : enrollments.reason,
      },
      resumeReview,
      notice,
    };
  };

  /** Read the review for one enrollment into the window, or say why it could not be read. */
  const loadReview = async (enrollmentId: string): Promise<void> => {
    const answer = await deps.api.read(
      '/enrollments/resume/preview',
      value => resumePreviewResponseSchema.parse(value),
      { enrollmentId },
    );
    if (answer.ok) {
      resumeReview = { asOf: answer.value.asOf, preview: answer.value.preview };
      notice = null;
      return;
    }
    resumeReview = null;
    notice = answer.reason;
  };

  const run = async (
    path: string,
    payload: Readonly<Record<string, unknown>>,
    accepted: string | null = null,
  ): Promise<SequenceState> => {
    const answer = await deps.api.command(path, payload, value => value);
    notice = answer.ok ? accepted : answer.reason;
    return await compose();
  };

  return {
    state: compose,

    openSequence: async input => {
      selectedSequenceId = input.sequenceId;
      notice = null;
      return await compose();
    },

    /**
     * Lane g88 (audit G03): a new sequence and its first draft, then the sequence opened.
     *
     * Two commands and two receipts, because they are two things the server records: a
     * named plan, and a version of it. A draft is what the step editor edits, so a
     * sequence with none would open to a page with nothing to type into.
     */
    createSequence: async input => {
      const created = await deps.api.command('/sequences/create', { name: input.name }, value =>
        createdSequenceSchema.parse(value),
      );
      if (!created.ok) {
        notice = created.reason;
        return await compose();
      }
      selectedSequenceId = created.value.id;
      const draft = await deps.api.command(
        '/sequences/versions/draft',
        { sequenceId: created.value.id, steps: [] },
        value => createdDraftSchema.parse(value),
      );
      notice = draft.ok ? 'sequence_created' : draft.reason;
      return await compose();
    },

    // "Editing a published sequence creates a new draft" (11.1): with no steps given,
    // the server copies the newest published version's.
    createDraft: async input => {
      const answer = await deps.api.command('/sequences/versions/draft', { sequenceId: input.sequenceId }, value =>
        createdDraftSchema.parse(value),
      );
      notice = answer.ok ? 'draft_created' : answer.reason;
      return await compose();
    },

    /**
     * Replace a draft's steps. The renderer's steps are parsed here — the window's word is
     * never taken for a shape — and numbered by their place, so the ordinals are 1..n
     * however the person reordered them.
     */
    saveDraft: async input => {
      const steps = draftStepsSchema.safeParse(input.steps);
      if (!steps.success) {
        notice = 'invalid_input';
        return await compose();
      }
      const answer = await deps.api.command(
        '/sequences/versions/steps',
        { sequenceVersionId: input.sequenceVersionId, steps: stepsForWire(steps.data as readonly DraftStep[]) },
        value => value,
      );
      notice = answer.ok ? 'draft_saved' : answer.reason;
      return await compose();
    },

    /**
     * An unapproved template version (lane g88). The footer 12.6 requires is appended
     * here, and the variables the version declares are the ones its text names, so the
     * approval's "unknown variable" can only mean a name Callie cannot fill — which the
     * form has already refused to send.
     */
    createTemplate: async input => {
      if (templateFormIssues(input).length > 0) {
        notice = 'invalid_input';
        return await compose();
      }
      const body = composeTemplateBody(input.body, input.signOff);
      const answer = await deps.api.command(
        '/templates/create',
        {
          ...(input.templateId === null ? {} : { templateId: input.templateId }),
          name: input.name.trim(),
          subject: input.subject.trim(),
          body,
          footerSignOff: input.signOff.trim(),
          requiredVariables: templateVariablesIn(input.subject, body).known,
        },
        value => value,
      );
      notice = answer.ok ? 'template_created' : answer.reason;
      return await compose();
    },

    publish: async input => await run('/sequences/versions/publish', input, 'published'),
    retire: async input => await run('/sequences/versions/retire', input, 'retired'),

    /**
     * The approval. A refusal carries every issue after its code; the transport keeps a
     * code only up to 80 characters, so the reason is read from the refusal's own body,
     * where the whole list is.
     */
    approveTemplate: async input => {
      const answer = await deps.api.command('/templates/approve', input, value => value);
      if (answer.ok) {
        notice = 'template_approved';
      } else {
        const refusal = answer.offline ? null : refusalReasonSchema.safeParse(answer.refusal);
        notice = (refusal?.success === true ? refusal.data.reason : answer.reason).slice(0, NOTICE_LIMIT);
      }
      return await compose();
    },
    enroll: async input => await run('/enrollments/enroll', input),

    reviewEnrollment: async input => {
      await loadReview(input.enrollmentId);
      return await compose();
    },

    closeReview: async () => {
      resumeReview = null;
      notice = null;
      return await compose();
    },

    /**
     * The confirmation (4.3; lane g88, audit G06). It resumes only the enrollment whose
     * review is on screen: asked for any other, it opens that one's review and resumes
     * nothing, so the review is always seen before the resume and the resume is always
     * the last thing pressed. The server decides again under its lock; the dates it
     * applies are the ones the review showed unless a hold opened in between, and then
     * the answer says so.
     */
    resumeEnrollment: async input => {
      if (resumeReview?.preview.enrollmentId !== input.enrollmentId) {
        await loadReview(input.enrollmentId);
        return await compose();
      }
      const answer = await deps.api.command('/enrollments/resume', input, value =>
        z.object({ kind: z.enum(['still_held', 'review_required', 'resume']) }).parse(value),
      );
      if (!answer.ok) {
        notice = answer.reason;
        return await compose();
      }
      resumeReview = null;
      notice = answer.value.kind === 'resume' ? 'resumed' : 'resume_still_held';
      return await compose();
    },
  };
}
