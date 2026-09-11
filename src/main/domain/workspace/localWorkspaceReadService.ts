import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../../db/database';
import { localWorkflowTransitionSchema, localWorkflowReceiptSchema, localWorkspaceSnapshotSchema, type LocalWorkflowReceipt, type LocalWorkspaceSnapshot } from '../../../shared/contracts/localWorkspaceContract';
import { AccountRepository } from '../accounts/accountRepository';
import { readWorkflowMode } from './legacyWorkflowTransition';
import { serializeCanonical } from '../lifecycle/lifecycleValidation';

/** Do not spread the raw manifest: runtime includes expectedMode and preservation internals. */
export function projectLocalWorkflowReceipt(value: unknown): LocalWorkflowReceipt {
  const r = z.record(z.string(), z.unknown()).parse(value);
  return localWorkflowReceiptSchema.parse({ commandId: r.commandId, manifestId: r.manifestId, mode: r.mode,
    revision: r.revision, occurredAt: r.occurredAt, cancelledActionIds: r.cancelledActionIds,
    stoppedEnrollmentIds: r.stoppedEnrollmentIds, preservedActionIds: r.preservedActionIds, parkedPersonIds: r.parkedPersonIds,
    callbackEvidenceIds: r.callbackEvidenceIds, unknownDraftIds: r.unknownDraftIds,
    parkedReviewActions: r.parkedReviewActions, parkedActions: r.parkedActions });
}
export function readLocalWorkspace(database: AppDatabase): LocalWorkspaceSnapshot {
  return database.raw.transaction(() => {
    const generatedAt = new Date().toISOString();
    const workflowMode = readWorkflowMode(database);
    const states = database.raw.prepare('SELECT singleton,mode,revision,updated_at FROM workspace_workflow_state').all();
    const stateSchema = z.strictObject({ singleton: z.literal(1), mode: z.enum(['legacy', 'meeting_first']), revision: z.number().int().positive().safe(), updated_at: z.string().datetime() });
    if (states.length > 1) throw new Error('Invalid canonical workflow state');
    const state = states.length ? stateSchema.parse(states[0]) : null;
    const rows = database.raw.prepare('SELECT command_id,manifest_id,fingerprint,result_json,created_at FROM workflow_transition_receipts').all();
    if (rows.length > 1) throw new Error('Multiple canonical workflow receipts');
    let transitionReceipt: LocalWorkflowReceipt | null = null;
    if (rows.length) {
      const row = z.strictObject({ command_id: z.string(), manifest_id: z.string(), fingerprint: z.string(), result_json: z.string(), created_at: z.string().datetime() }).parse(rows[0]);
      const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(row.result_json));
      transitionReceipt = projectLocalWorkflowReceipt(raw);
      const r = transitionReceipt;
      const command = localWorkflowTransitionSchema.parse({ commandId: r.commandId, expectedMode: raw.expectedMode, manifestId: r.manifestId });
      const fingerprint = createHash('sha256').update(serializeCanonical(command)).digest('hex');
      if (command.commandId !== r.commandId || command.manifestId !== r.manifestId || row.command_id !== r.commandId || row.manifest_id !== r.manifestId
        || row.fingerprint !== fingerprint || state?.mode !== 'meeting_first' || state.revision !== r.revision
        || state.updated_at !== r.occurredAt || row.created_at !== r.occurredAt) throw new Error('Invalid canonical workflow receipt');
    }
    let accounts: LocalWorkspaceSnapshot['accounts'];
    try {
      const repository = new AccountRepository({ database, clock: { now: () => generatedAt }, ids: { next: () => { throw new Error('Read cannot allocate identities'); } } });
      const ids = z.array(z.strictObject({ id: z.string().min(1) })).parse(database.raw.prepare('SELECT id FROM pm_accounts ORDER BY id').all());
      accounts = localWorkspaceSnapshotSchema.shape.accounts.parse({ state: 'available', snapshots: ids.map(({ id }) => repository.snapshot(id, generatedAt)) });
    } catch { accounts = { state: 'unavailable', snapshots: [] }; }
    return localWorkspaceSnapshotSchema.parse({ scope: 'local_database', generatedAt, workflowMode, transitionReceipt, accounts });
  }).deferred();
}
