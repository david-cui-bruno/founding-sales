/**
 * Retention, deletion and departure (specification 10.3, Appendix C, Appendix F,
 * Appendix G scenario 41).
 *
 * The retention table of 10.3 as scheduled jobs with a run ledger; the documented
 * deletion workflow with its preview and its minimal normalized tombstone; the
 * departure command; and the authorized open-in-Gmail link that is the whole of what
 * FSS does with an attachment. See `docs/greenfield/retention.md`.
 */

export {
  RETENTION_LEDGER_KINDS,
  RETENTION_POLICY_KINDS,
  isRetentionLedgerKind,
  retentionBatchJobKey,
  retentionPeriodOf,
  type RetentionLedgerKind,
  type RetentionPolicyKind,
} from './kinds.ts';

export {
  readRetentionPolicies,
  readRetentionPolicy,
  retentionBoundary,
  type RetentionDisposition,
  type RetentionPolicyRow,
} from './policies.ts';

export {
  JOB_PAYLOAD_WINDOW_DAYS,
  PENDING_RETENTION_TABLES,
  RETENTION_BATCH_LIMIT,
  RETENTION_TARGETS,
  retentionTargetFor,
  type PendingRetentionTable,
  type RetentionSweepInput,
  type RetentionSweepResult,
  type RetentionTarget,
  type RetentionTargetState,
} from './targets.ts';

export {
  COVERAGE_EXEMPT_TABLES,
  TABLE_RETENTION_COVERAGE,
  type TableCoverage,
  type TableDisposition,
} from './coverage.ts';

export {
  RetentionKindError,
  listRetentionRuns,
  runRetentionBatch,
  type RetentionRunOutcome,
  type RetentionRunReport,
  type RetentionRunView,
  type RunRetentionBatchInput,
} from './runs.ts';

export { retentionBatchHandler } from './handler.ts';

export {
  REDACTED_NAME,
  commitDeletion,
  previewDeletion,
  type CommitDeletionInput,
  type DeletionOutcome,
  type DeletionPreview,
  type DeletionRefusal,
  type DeletionTargetKind,
  type PreviewDeletionInput,
} from './deletion.ts';

export {
  commitDeparture,
  previewDeparture,
  type CommitDepartureInput,
  type DeparturePreview,
  type DepartureOutcome,
  type DepartureRefusal,
} from './departure.ts';

export {
  gmailMessageUrl,
  readAttachmentReferences,
  type AttachmentReference,
  type AttachmentRefusal,
  type AttachmentView,
} from './attachments.ts';

export type { RetentionResult } from './result.ts';
