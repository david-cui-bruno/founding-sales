import { z } from 'zod';
import {
  enrollmentsResponseSchema,
  sequenceVersionsResponseSchema,
  sequencesResponseSchema,
  templateVersionsResponseSchema,
  uuid,
} from '@fss/contracts';
import {
  draftStepSchema,
  type DraftStep,
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
 * The Sequences view's half of the bridge, in the main process (specification 11.1,
 * 4.3, 14.2).
 *
 * The window sees a `SequenceState` and nothing else: no access token, no command id.
 * Nothing in this file imports `electron`, and the whole bridge is testable without a
 * window. Since 1.0.13 nothing here is a channel of its own either: every method is an
 * operation of the registry (`src/shared/operations.ts`), so the argument checking that
 * was written out per channel is the operation's input schema.
 *
 * **An edit of something frozen is a new version** (send-path v2, S2; David, 30 September
 * 2026: "Existing enrollments keep their original steps, template versions, and cadence.
 * Edits affect new enrollments by default."). Saving the steps of a published version
 * writes them to the sequence's draft — the server answers which version, and the notice
 * names it — and saving an approved template writes its next version. The published
 * version and the approved template are exactly as they were, and so is everybody
 * already enrolled; publishing the draft is what new enrollments pick up.
 * `/sequences/versions/draft` is still called in one place — the first, empty version
 * of a sequence that has just been created.
 *
 * Two things went with wave 2 and are named here so nobody looks for them.
 *
 * **Approval is not a separate press.** `/templates/create` and `/templates/update` take
 * `approve: true` and refuse the whole command with every issue when the text does not
 * pass, so a version is never written that cannot be approved, and `/templates/approve`
 * has no caller.
 *
 * **The long-hold review is gone.** An enrollment held that long resumes on its own
 * (S4.1), `review_required` is never sent, and `/enrollments/resume/preview` and
 * `/enrollments/resume` have no caller here. `/enrollments` itself is still read: the
 * view lists who is in flight, with nothing to confirm about any of them.
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
  /** Drop the snapshot on an identity transition (1.0.13, P0-A). */
  forget(): Promise<SequenceState>;
  state(): Promise<SequenceState>;
  openSequence(input: { readonly sequenceId: string }): Promise<SequenceState>;
  createSequence(input: { readonly name: string }): Promise<SequenceState>;
  saveSteps(input: { readonly sequenceVersionId: string; readonly steps: readonly DraftStep[] }): Promise<SequenceState>;
  saveTemplate(input: TemplateDraft): Promise<SequenceState>;
  publish(input: { readonly sequenceVersionId: string }): Promise<SequenceState>;
  retire(input: { readonly sequenceVersionId: string }): Promise<SequenceState>;
}

/** What `/sequences/create` and `/sequences/versions/draft` answer, as far as the bridge reads them. */
const createdSequenceSchema = z.object({ id: uuid });
const createdDraftSchema = z.object({ sequenceVersionId: uuid });
/**
 * Where a steps save went (send-path v2, S2). Read leniently: a server from before S2
 * answers `{ steps }` alone, which is a save in place, and says so.
 */
const savedStepsSchema = z.unknown().transform(value => {
  const parsed = z
    .object({ sequenceVersionId: uuid, version: z.number().int().min(1), newVersion: z.boolean() })
    .safeParse(value);
  return parsed.success ? parsed.data : null;
});
/** The id and number of the version a template save answered with. */
const savedTemplateSchema = z.unknown().transform(value => {
  const parsed = z.object({ id: uuid, version: z.number().int().min(1) }).safeParse(value);
  return parsed.success ? parsed.data : null;
});
/** A refused save-and-approve: `template_unapproved:` and every issue it named. */
const refusalReasonSchema = z.object({ reason: z.string().min(1) });
/**
 * The copy warnings in a template save's accepted result: codes that advise and never
 * refuse. Read off whatever shape the answer has, so a server that stops sending them is
 * an empty list rather than a parse failure.
 */
const warningCodes = z.array(z.string().min(1).max(80)).max(20);
const templateWarningsSchema = z.unknown().transform(value => {
  const listed = typeof value === 'object' && value !== null ? (value as { warnings?: unknown }).warnings : undefined;
  const parsed = warningCodes.safeParse(listed);
  return { warnings: parsed.success ? parsed.data : [] };
});
const draftStepsSchema = z.array(draftStepSchema).max(50);

/** The longest notice the window's state may carry. A refused approval's issues are cut to it. */
const NOTICE_LIMIT = 400;

export function createSequenceBridge(deps: SequenceBridgeDeps): SequenceBridgeHost {
  let selectedSequenceId: string | null = null;
  let notice: string | null = null;
  /** The last template save's copy warnings; cleared by every other act. */
  let warnings: readonly string[] = [];

  /**
   * Read everything the window shows, in one pass.
   *
   * A refusal on any one read leaves that part empty rather than throwing: 4.2's
   * rule is that the client shows what it has and fails mutations closed, and a
   * window that went blank because one list was unavailable would be worse than one
   * that shows two of three.
   *
   * Empty is not the same as unavailable, though (lane g78, D06). Each slice carries its
   * read's refusal code in `readErrors`, and the window says it could not read that part,
   * with Retry, instead of drawing an empty list.
   */
  const compose = async (): Promise<SequenceState> => {
    const session = await deps.session.state();
    const isAdmin = session.device?.role === 'admin';
    // Always asked, even when the session last found the server away (wave 1): otherwise
    // nothing here could find out the connection was back.
    const sequences = await deps.api.read('/sequences', value => sequencesResponseSchema.parse(value));
    if (!sequences.ok && sequences.offline) {
      return { ...EMPTY_SEQUENCE_STATE, isAdmin, mayMutate: session.mayMutate, notice, warnings: [...warnings] };
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
      sequences: [...list],
      selectedSequenceId: chosen,
      versions: versions !== null && versions.ok ? [...versions.value.versions] : [],
      templates: templates.ok ? [...templates.value.templates] : [],
      enrollments: enrollments.ok ? [...enrollments.value.enrollments] : [],
      readErrors: {
        sequences: sequences.ok ? null : sequences.reason,
        versions: versions === null || versions.ok ? null : versions.reason,
        templates: templates.ok ? null : templates.reason,
        enrollments: enrollments.ok ? null : enrollments.reason,
      },
      notice,
      warnings: [...warnings],
    };
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

  const host: SequenceBridgeHost = {
    /**
     * Forget everything this bridge is holding (1.0.13, P0-A).
     *
     * Called on every identity transition, from `registerWindows`. Nothing here is the
     * next person's to read, and a snapshot kept across a sign-out is the last person's
     * work shown to somebody else.
     */
    async forget() {
      selectedSequenceId = null;
      notice = null;
      warnings = [];
      return await compose();
    },

    state: compose,

    openSequence: async input => {
      selectedSequenceId = input.sequenceId;
      notice = null;
      return await compose();
    },

    /**
     * A new sequence and its first, empty version, then the sequence opened.
     *
     * Two commands and two receipts, because they are two things the server records: a
     * named plan, and a version of it. `/sequences/versions/draft` is the only route that
     * makes a version, so this is its one remaining caller — a sequence with no version
     * would open to a page with nothing to type into.
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
      const version = await deps.api.command(
        '/sequences/versions/draft',
        { sequenceId: created.value.id, steps: [] },
        value => createdDraftSchema.parse(value),
      );
      notice = version.ok ? 'sequence_created' : version.reason;
      return await compose();
    },

    /**
     * Save a version's steps. The renderer's steps are parsed here — the window's word is
     * never taken for a shape — and numbered by their place, so the ordinals are 1..n
     * however the person reordered them. A draft is saved as it is; a published version
     * is not written to, and the server answers the draft version the edit became, which
     * the notice names (`steps_saved_as_version:<n>`).
     */
    saveSteps: async input => {
      const steps = draftStepsSchema.safeParse(input.steps);
      if (!steps.success) {
        notice = 'invalid_input';
        return await compose();
      }
      const answer = await deps.api.command(
        '/sequences/versions/steps',
        { sequenceVersionId: input.sequenceVersionId, steps: stepsForWire(steps.data as readonly DraftStep[]) },
        value => savedStepsSchema.parse(value),
      );
      notice = !answer.ok
        ? answer.reason
        : answer.value !== null && answer.value.newVersion
          ? `steps_saved_as_version:${String(answer.value.version)}`
          : 'steps_saved';
      return await compose();
    },

    /**
     * Save a template version and approve it in the same command (wave 2, S3; D5).
     *
     * Saving an approved version writes the template's next version and leaves the
     * approved one as it was (send-path v2, S2); the notice names the new number
     * (`template_saved_as_version:<n>`).
     *
     * The footer 12.6 requires is appended here, and the variables the version declares
     * are the ones its text names, so "unknown variable" can only mean a name Callie
     * cannot fill — which the form has already refused to send. A refusal carries every
     * issue after its code; the transport keeps a code only up to 80 characters, so the
     * reason is read from the refusal's own body, where the whole list is.
     */
    saveTemplate: async input => {
      if (templateFormIssues(input).length > 0) {
        notice = 'invalid_input';
        warnings = [];
        return await compose();
      }
      const body = composeTemplateBody(input.body, input.signOff);
      const text = {
        name: input.name.trim(),
        subject: input.subject.trim(),
        body,
        footerSignOff: input.signOff.trim(),
        requiredVariables: templateVariablesIn(input.subject, body).known,
        approve: true,
      };
      const parse = (value: unknown) => ({
        ...templateWarningsSchema.parse(value),
        saved: savedTemplateSchema.parse(value),
      });
      const answer =
        input.templateVersionId === null
          ? await deps.api.command('/templates/create', text, parse)
          : await deps.api.command('/templates/update', { templateVersionId: input.templateVersionId, ...text }, parse);
      warnings = answer.ok ? answer.value.warnings : [];
      if (answer.ok) {
        const saved = answer.value.saved;
        notice =
          input.templateVersionId !== null && saved !== null && saved.id !== input.templateVersionId
            ? `template_saved_as_version:${String(saved.version)}`
            : 'template_saved';
      } else {
        const refusal = answer.offline ? null : refusalReasonSchema.safeParse(answer.refusal);
        notice = (refusal?.success === true ? refusal.data.reason : answer.reason).slice(0, NOTICE_LIMIT);
      }
      return await compose();
    },

    publish: async input => await run('/sequences/versions/publish', input, 'published'),
    retire: async input => await run('/sequences/versions/retire', input, 'retired'),
  };

  // Every act but a read and a template save clears the last warnings: they are about
  // that template's text, and belong on screen only until the next act.
  const cleared = <A extends unknown[]>(act: (...args: A) => Promise<SequenceState>) =>
    async (...args: A): Promise<SequenceState> => {
      warnings = [];
      return await act(...args);
    };
  return {
    ...host,
    openSequence: cleared(host.openSequence),
    createSequence: cleared(host.createSequence),
    saveSteps: cleared(host.saveSteps),
    publish: cleared(host.publish),
    retire: cleared(host.retire),
  };
}
