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
 * same deployment the worker reads.
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
  listOpenHolds,
  releaseHoldsOfReason,
  type HoldFilter,
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
} from './report.ts';
