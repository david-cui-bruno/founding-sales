/**
 * The insert-only suppression protocol (specification 10.2).
 *
 * One view is authoritative, one journal write precedes every acknowledgement, one
 * winner decides every ten-minute window, and nothing here can change a row that has
 * been written. See `docs/greenfield/suppression.md`.
 */

export {
  deterministicEventId,
  journalObjectBody,
  journalObjectKey,
  SUPPRESSION_JOURNAL_SCHEMA,
  recordingSuppressionJournal,
  SuppressionJournalError,
  type DeterministicEventIdInput,
  type JournalScope,
  type RecordingSuppressionJournal,
  type SuppressionJournal,
  type SuppressionJournalRecord,
} from './journal.ts';

export {
  firstSuppressed,
  isSuppressed,
  listEffectiveSuppressions,
  type EffectiveSuppression,
} from './effective.ts';

export {
  readSuppressionEvent,
  recordAdminSupersession,
  recordCorrection,
  recordSuppression,
  type CorrectionOutcome,
  type RecordSuppressionInput,
  type RecordedSuppression,
  type SuppressionEventRow,
  type SuppressionResult,
} from './events.ts';

export {
  claimFinalization,
  finalizeManualSuppression,
  readFinalization,
  type ClaimFinalizationInput,
  type FinalizationClaim,
  type FinalizationOutcome,
  type FinalizeResult,
} from './finalize.ts';

export { suppressionFinalizeHandler } from './handler.ts';

export {
  parseSuppressionJournalRecord,
  replaySuppressionJournal,
  type JournalParseRefusal,
  type JournalParseResult,
  type JournalReplayReport,
  type ReplayInput,
  type SuppressionJournalSource,
} from './replay.ts';
