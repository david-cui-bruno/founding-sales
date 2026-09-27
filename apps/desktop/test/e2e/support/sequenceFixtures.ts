import type { SequenceState } from '../../../src/renderer/sequenceContract.ts';
import { EMPTY_SEQUENCE_STATE } from '../../../src/renderer/sequenceView.ts';
import {
  SEQUENCE_IDS,
  callStepAnswer,
  emailStepAnswer,
  enrollmentAnswer,
  sequenceSummaryAnswer,
  sequenceVersionAnswer,
  templateVersionAnswer,
} from '../../support/sequenceAnswers.ts';

/**
 * The Sequences view's fixtures, for the one harness (`appServer.ts`), whose
 * `sequences` option is the list of states `state()` answers one per call.
 *
 * The states are built from `../../support/sequenceAnswers.ts`, the fixtures the
 * release suite holds to the real routes, so a version drawn here has the steps the API
 * actually sends. What the page does with a failed read is scripted: the first `state`
 * answers with the reads that failed, and the next answers with them read, which is
 * what Retry is for.
 *
 * No real person, firm or profile appears. `example.test` is reserved by RFC 6761.
 */

/** A populated window: one published version with both kinds of step, and one template. */
export function populatedSequenceState(overrides: Partial<SequenceState> = {}): SequenceState {
  return {
    ...EMPTY_SEQUENCE_STATE,
    online: true,
    mayMutate: true,
    isAdmin: true,
    sequences: [sequenceSummaryAnswer()],
    selectedSequenceId: SEQUENCE_IDS.sequence,
    versions: [
      sequenceVersionAnswer([emailStepAnswer(SEQUENCE_IDS.template), callStepAnswer()], {
        version: 1,
        state: 'published',
        publishedAt: '2026-09-20T12:00:00.000Z',
      }),
    ],
    templates: [templateVersionAnswer()],
    enrollments: [enrollmentAnswer()],
    ...overrides,
  };
}

/**
 * Lane g88: a sequence just created — its draft has no steps — beside one approved
 * template, and nothing enrolled. What the founder sees before authoring anything.
 */
export function emptyDraftState(overrides: Partial<SequenceState> = {}): SequenceState {
  return populatedSequenceState({
    versions: [sequenceVersionAnswer([], { version: 1, state: 'draft' })],
    enrollments: [],
    ...overrides,
  });
}

/** The same window with two of its four reads failed, as the bridge reports them. */
export function unreadSequenceState(): SequenceState {
  return populatedSequenceState({
    versions: [],
    templates: [],
    readErrors: { sequences: null, versions: 'unreadable_answer', templates: 'service_unavailable', enrollments: null },
  });
}
