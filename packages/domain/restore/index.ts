/**
 * What a point-in-time restore needs from the database side, and nothing else.
 *
 * The restore itself is a runbook (`docs/greenfield/runbooks/restore.md`): stop both
 * services, restore to a new instance, point `active_database_host` at it, replay the
 * suppression journal, reconcile the Sent folders, re-put the release record, start.
 * `recoverSentFolderMessage` is the database half of the Sent-folder step: `scanSentFolder`
 * reads the folder, and this decides what each FSS send found there means to the restored
 * copy. `fss admin mailbox reconcile-sent` (`apps/worker/src/tools/fss/admin.ts`) runs
 * both, with a read-only Gmail client.
 */

export {
  RESTORE_ACTOR,
  listOpenHolds,
  listWorkspaceIds,
  type HoldFilter,
  type ScopedOpenHold,
} from './holds.ts';

export {
  RESTORE_SENT_SCAN_SKEW_SECONDS,
  recoverSentFolderMessage,
  type RecoverSentMessageInput,
  type SentMessageRecovery,
  type UnattachedReason,
} from './missingFences.ts';
