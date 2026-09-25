import {
  enrollmentsResponseSchema,
  linkedInHandoffResultSchema,
  sequenceVersionsResponseSchema,
  sequencesResponseSchema,
  templateVersionsResponseSchema,
} from '@fss/contracts';
import { linkedInCardSchema, type LinkedInCard, type SequenceState } from '../renderer/sequenceContract.ts';
import { EMPTY_SEQUENCE_STATE } from '../renderer/sequenceView.ts';
import type { AuthedClient } from './authedClient.ts';

/**
 * The sequence editor's half of the bridge, in the main process (specification 11.1,
 * 11.3, 4.3, 14.2).
 *
 * The window sees a `SequenceState` and nothing else: no access token, no command id,
 * no clipboard handle. Two things about that are worth naming.
 *
 * **The clipboard and the browser open happen here, after the server has recorded
 * the handoff.** 11.3's order is copy, open, complete; the order that survives a
 * failure is complete, then copy and open, because the completion is the fact the
 * database has to agree with and a clipboard that refused is something a person can
 * see and work around. The undo exists for exactly the case where the open did not
 * work. `docs/decisions/g8-linkedin-handoff-order.md` records the reasoning.
 *
 * **Every deadline is the server's.** `asOf` carries database time into the state,
 * and `sequenceView.ts` compares the undo deadline with it. A Mac whose clock is fast
 * must not be able to show an undo the server would refuse, nor hide one it would
 * accept.
 *
 * Both side effects are ports. `copyToClipboard` and `openExternally` are supplied by
 * `main.ts` from Electron; the tests supply recorders, so nothing in this file
 * imports `electron` and the whole bridge is testable without a window.
 */

export const SEQUENCE_IPC_CHANNELS = {
  state: 'callie:sequences:state',
  openSequence: 'callie:sequences:open',
  createSequence: 'callie:sequences:create',
  saveDraft: 'callie:sequences:draft',
  publish: 'callie:sequences:publish',
  retire: 'callie:sequences:retire',
  approveTemplate: 'callie:sequences:approve-template',
  enroll: 'callie:sequences:enroll',
  completeLinkedIn: 'callie:sequences:linkedin-complete',
  undoLinkedIn: 'callie:sequences:linkedin-undo',
  recordLinkedInResult: 'callie:sequences:linkedin-result',
  resumeEnrollment: 'callie:sequences:resume',
} as const;
export type SequenceIpcChannel = (typeof SEQUENCE_IPC_CHANNELS)[keyof typeof SEQUENCE_IPC_CHANNELS];

/*
 * Every answer is parsed with `@fss/contracts`' schema for its route (lane g78), the one
 * the route's own test holds the real answer to. The window's projection — which
 * enrollments are held, which clock the undo is compared with — is made below, from a
 * parse that already agrees with the server.
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
  /** The macOS clipboard, as a port. */
  readonly copyToClipboard: (text: string) => void;
  /** `shell.openExternal`, as a port. Refuses anything that is not an https URL. */
  readonly openExternally: (url: string) => Promise<void>;
}

export interface SequenceBridgeHost {
  state(): Promise<SequenceState>;
  openSequence(input: { readonly sequenceId: string }): Promise<SequenceState>;
  createSequence(input: { readonly name: string }): Promise<SequenceState>;
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

/** Only an https LinkedIn profile is ever opened. Anything else is refused here. */
export function isOpenableProfile(url: string | null): url is string {
  if (url === null) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)linkedin\.com$/u.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function createSequenceBridge(deps: SequenceBridgeDeps): SequenceBridgeHost {
  let selectedSequenceId: string | null = null;
  let linkedInCard: LinkedInCard | null = null;
  let notice: string | null = null;

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
    if (!session.online) {
      return { ...EMPTY_SEQUENCE_STATE, isAdmin, notice, linkedInCard };
    }

    const sequences = await deps.api.read('/sequences', value => sequencesResponseSchema.parse(value));
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
      // Database time, from the API. Never this Mac's clock (11.3).
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
      linkedInCard,
      notice,
    };
  };

  const run = async (
    path: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<SequenceState> => {
    const answer = await deps.api.command(path, payload, value => value);
    notice = answer.ok ? null : answer.reason;
    return await compose();
  };

  return {
    state: compose,

    openSequence: async input => {
      selectedSequenceId = input.sequenceId;
      notice = null;
      return await compose();
    },

    createSequence: async input => await run('/sequences/create', { name: input.name }),
    publish: async input => await run('/sequences/versions/publish', input),
    retire: async input => await run('/sequences/versions/retire', input),
    approveTemplate: async input => await run('/templates/approve', input),
    enroll: async input => await run('/enrollments/enroll', input),

    /**
     * 11.3's "Open LinkedIn & copy message".
     *
     * The server records the handoff first. Only then is the text copied and the
     * profile opened, because the database is the thing that has to be true and the
     * clipboard is the thing a person can retry. A profile that is not an https
     * `linkedin.com` URL is not opened at all, and the notice says so.
     */
    completeLinkedIn: async input => {
      const answer = await deps.api.command(
        '/enrollments/linkedin/complete',
        input,
        value => linkedInHandoffResultSchema.parse(value),
      );
      if (!answer.ok) {
        notice = answer.reason;
        return await compose();
      }
      const handoff = answer.value;
      deps.copyToClipboard(handoff.message);
      if (isOpenableProfile(handoff.linkedInUrl)) {
        await deps.openExternally(handoff.linkedInUrl);
        notice = 'Message copied and the profile opened. FSS has not claimed it was sent.';
      } else {
        notice = 'Message copied. This contact has no usable LinkedIn profile to open.';
      }
      const card = linkedInCardSchema.safeParse({
        stepExecutionId: handoff.stepExecutionId,
        enrollmentId: linkedInCard?.enrollmentId ?? handoff.stepExecutionId,
        contactName: linkedInCard?.contactName ?? null,
        linkedInUrl: handoff.linkedInUrl,
        message: handoff.message,
        handedOff: true,
        undoUntil: handoff.undoUntil,
      });
      if (card.success) linkedInCard = card.data;
      return await compose();
    },

    undoLinkedIn: async input => {
      const answer = await deps.api.command('/enrollments/linkedin/undo', input, value => value);
      if (!answer.ok) {
        // "Fails visibly" (11.3): the notice says the undo did not happen, and why.
        notice =
          answer.reason === 'successor_dispatching'
            ? 'The next step has already begun sending. The handoff cannot be undone.'
            : 'The ten-minute undo window has closed.';
        return await compose();
      }
      if (linkedInCard !== null) {
        linkedInCard = { ...linkedInCard, handedOff: false, undoUntil: null };
      }
      notice = 'The handoff was undone and the next step cancelled.';
      return await compose();
    },

    recordLinkedInResult: async input => {
      const state = await run('/enrollments/linkedin/result', input);
      if (input.result === 'replied') linkedInCard = null;
      return state;
    },

    resumeEnrollment: async input => await run('/enrollments/resume', input),
  };
}
