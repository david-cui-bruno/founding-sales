/**
 * The post-restore protocol (specification Appendix E, Appendix G 11).
 *
 * Appendix E is nine steps, and until this lane every one of them was a sentence in
 * `docs/greenfield/restore-drill.md` and nothing a process could run: the drill called
 * an `fss admin` command line that did not exist. These are the operations behind it —
 * the counts, the job discard, the hold listing, the generation advance and the
 * reconciliation report — and `apps/worker/src/tools/fss.ts` is the command line that
 * wraps them.
 *
 * Nothing here talks to anything but PostgreSQL. The two steps that need Gmail
 * (reconstructing sends from Sent folders, reprocessing inboxes) already exist in
 * `@fss/domain/outbound` and `@fss/domain/mail`, and the tool composes them from the
 * same deployment the worker reads. Lane g73's `recoverSentFolderMessage` is the
 * database half of step 3's missing fences: `scanSentFolder` reads the folder, and this
 * decides what each FSS send found there means to the restored copy.
 */

export {
  CRM_EDIT_ACTION_PREFIXES,
  OPT_OUT_EFFECT_KINDS,
  REPLY_EFFECT_KINDS,
  countRecoveryEffects,
  countRepeatedSends,
  listWorkspaceIds,
  newestCrmEditAt,
  readRestoreCounts,
  type RecoveryEffectCounts,
  type RestoreCounts,
  type RestoreCountsOptions,
  type WorkspaceRestoreCounts,
} from './counts.ts';

export { discardRunnableJobs, type DiscardRunnableReport } from './jobs.ts';

export {
  RESTORE_ACTOR,
  RESTORE_HOLDS_LOCK_KEY,
  listOpenHolds,
  openRestoreHolds,
  releaseHoldsOfReason,
  type HoldFilter,
  type OpenRestoreHoldsInput,
  type OpenedRestoreHolds,
  type RestoreHoldOpener,
  type ScopedOpenHold,
} from './holds.ts';

export {
  advanceSystemGeneration,
  type AdvanceInput,
  type AdvanceRefusal,
  type AdvanceResult,
  type GenerationAdvance,
} from './generation.ts';

export {
  composeRestoreReport,
  crmRecoveryPointSeconds,
  readUnresolvedExceptions,
  verifyRestoreReport,
  type ComposeRestoreReportInput,
  type ReportVerdict,
  type RestoreReport,
  type UnresolvedAmbiguity,
  type UnresolvedEntry,
  type UnresolvedExceptions,
  type UnresolvedFence,
  type UnresolvedSentFolderItem,
} from './report.ts';

export {
  RESTORE_SENT_SCAN_SKEW_SECONDS,
  recoverSentFolderMessage,
  type RecoverSentMessageInput,
  type SentMessageRecovery,
  type UnattachedReason,
} from './missingFences.ts';
