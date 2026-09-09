import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import type { IdGenerator } from '../support/idGenerator';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import { DomainRepositoryDatabaseMismatchError, LifecycleEligibilityError } from '../support/domainErrors';
import { NextActionRepository } from '../lifecycle/nextActionRepository';
import { SalesCycleRepository } from '../lifecycle/salesCycleRepository';
import { serializeCanonical } from '../lifecycle/lifecycleValidation';
import type { NextAction, CadenceActionBinding } from '../lifecycle/lifecycleTypes';

export type WorkflowMode = 'legacy' | 'meeting_first';
export function canScheduleLegacy(input: { mode: WorkflowMode | null; kind: 'automatic_acquisition' | 'recorded_promise' | 'fulfillment' | 'inbound_response' }): boolean {
  return input.mode !== 'meeting_first' || input.kind !== 'automatic_acquisition';
}
export function readWorkflowMode(database: AppDatabase): WorkflowMode {
  if (!database.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_workflow_state'").get()) return 'legacy';
  const rows = database.raw.prepare('SELECT singleton,mode,revision,updated_at FROM workspace_workflow_state').all();
  if (!rows.length) return 'legacy';
  if (rows.length !== 1) throw new Error('Corrupt workspace workflow state.');
  return z.object({ singleton: z.literal(1), mode: z.enum(['legacy', 'meeting_first']), revision: z.number().int().positive(), updated_at: z.string().datetime() }).parse(rows[0]).mode;
}
export function assertLegacyScheduling(database: AppDatabase, kind: Parameters<typeof canScheduleLegacy>[0]['kind']): void {
  if (!canScheduleLegacy({ mode: readWorkflowMode(database), kind })) throw new LifecycleEligibilityError('Meeting-first mode stops superseded automatic legacy acquisition.');
}
/** Exact legacy review shape only. New obligation evidence always defeats parking. */
export function legacyReviewParkingEligibilitySql(cycle: 'c' | 'cycle'): string {
  return `${cycle}.stage='unreviewed' AND ${cycle}.workflow_status='active'
    AND ${cycle}.resurface_at IS NULL AND ${cycle}.resurface_reason IS NULL
    AND EXISTS (SELECT 1 FROM next_actions review WHERE review.id=${cycle}.current_next_action_id
      AND review.sales_cycle_id=${cycle}.id AND review.status='pending' AND review.action_type='review_lead'
      AND review.work_intent='internal_review' AND review.channel IS NULL
      AND review.inbound_sla_kind IS NULL AND review.inbound_sla_due_at IS NULL
      AND review.inbound_sla_source_event_id IS NULL AND review.inbound_sla_provenance_json IS NULL
      AND review.due_source='internal_review' AND review.cadence_enrollment_id IS NULL
      AND review.cadence_step_id IS NULL AND review.cadence_component_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM next_actions owed WHERE owed.sales_cycle_id=${cycle}.id
      AND owed.status='pending' AND owed.id<>${cycle}.current_next_action_id)
    AND NOT EXISTS (SELECT 1 FROM activities evidence WHERE evidence.sales_cycle_id=${cycle}.id
      AND (evidence.callback_at IS NOT NULL OR evidence.direction='inbound'))
    AND NOT EXISTS (SELECT 1 FROM source_events inbound WHERE inbound.person_id=${cycle}.person_id
      AND inbound.channel IN ('inbound_demo','referral'))
    AND NOT EXISTS (SELECT 1 FROM email_drafts uncertain WHERE uncertain.sales_cycle_id=${cycle}.id
      AND uncertain.status IN ('sending','unknown'))`;
}
const commandSchema = z.strictObject({ commandId: z.string().trim().min(1), expectedMode: z.enum(['legacy', 'meeting_first']), manifestId: z.string().trim().min(1) });
export type WorkflowTransitionCommand = z.infer<typeof commandSchema>;
export type WorkflowTransitionManifest = {
  commandId: string; manifestId: string; mode: 'meeting_first'; revision: number; occurredAt: string;
  cancelledActionIds: string[]; stoppedEnrollmentIds: string[]; preservedActionIds: string[]; parkedPersonIds: string[];
  actionSnapshots: NextAction[]; sourceIdentities: { cycleId: string; personId: string; prospectId: string; sourceEventId: string; version: number }[];
  catalogs: { id: string; contentHash: string; version: number }[];
  enrollmentSnapshots: { id: string; definitionId: string; version: number; status: string; currentStepId: string | null; allowedStepIdsJson: string | null }[];
  callbackEvidenceIds: string[]; unknownDraftIds: string[];
  parkedReviewActions: { id: string; cycleId: string; version: number }[];
  parkedActions: { id: string; supersededActionId: string; cycleId: string }[];
};
const noCadence: CadenceActionBinding = { cadenceEnrollmentId: null, cadenceDefinitionId: null, cadenceStepId: null, cadenceComponentId: null } as const;

/** No startup activation. Only this explicit command creates mode state and an immutable receipt atomically. */
export class LegacyWorkflowTransition {
  constructor(private readonly input: { database: AppDatabase; unitOfWork: DomainUnitOfWork; clock: Clock; ids: IdGenerator }) {
    if (input.database.raw !== input.unitOfWork.database.raw) throw new DomainRepositoryDatabaseMismatchError();
  }
  transitionWorkflow(input: WorkflowTransitionCommand): WorkflowTransitionManifest {
    const command = commandSchema.parse(input);
    const fingerprint = createHash('sha256').update(serializeCanonical(command)).digest('hex');
    const { database, unitOfWork, clock } = this.input;
    return unitOfWork.immediate(() => {
      const receipt = database.raw.prepare('SELECT fingerprint,result_json FROM workflow_transition_receipts WHERE command_id=?').get(command.commandId) as { fingerprint: string; result_json: string } | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new Error('Workflow transition command identity conflict.');
        return JSON.parse(receipt.result_json) as WorkflowTransitionManifest;
      }
      const mode = readWorkflowMode(database);
      if (mode !== command.expectedMode || mode === 'meeting_first') throw new Error('Stale workflow transition mode.');
      const state = database.raw.prepare('SELECT revision FROM workspace_workflow_state WHERE singleton=1').get() as { revision: number } | undefined;
      const occurredAt = clock.now(), revision = (state?.revision ?? 0) + 1;
      const actions = new NextActionRepository({ database, unitOfWork });
      const cycles = new SalesCycleRepository({ database, unitOfWork });
      const sourceIdentities = database.raw.prepare(`SELECT id AS cycleId,person_id AS personId,prospect_id AS prospectId,entry_source_event_id AS sourceEventId,version FROM sales_cycles ORDER BY id`).all() as WorkflowTransitionManifest['sourceIdentities'];
      const actionSnapshots = (database.raw.prepare("SELECT id FROM next_actions WHERE status='pending' ORDER BY id").all() as { id: string }[]).map(row => actions.getById(row.id)!);
      const candidates = actionSnapshots.filter(action => {
        if (action.workIntent !== 'discretionary_prospecting' || action.cadence.cadenceEnrollmentId === null || action.dueSource === 'recorded_callback' || action.dueSource === 'founder_resurface') return false;
        const cycle = cycles.getById(action.salesCycleId);
        if (!cycle || cycle.workflowStatus !== 'active' || cycle.resurfaceReason === 'callback') return false;
        // Old callback writes did not always update action intent/due_source. Preserve conservatively.
        if (database.raw.prepare('SELECT 1 FROM activities WHERE sales_cycle_id=? AND callback_at IS NOT NULL LIMIT 1').get(cycle.id)) return false;
        const definition = database.raw.prepare('SELECT family FROM cadence_definitions WHERE id=?').get(action.cadence.cadenceDefinitionId) as { family: string };
        if (!['cadence_a', 'cadence_b', 'cadence_c'].includes(definition.family)) return false;
        return !database.raw.prepare("SELECT 1 FROM email_drafts WHERE sales_cycle_id=? AND status IN('sending','unknown') LIMIT 1").get(cycle.id);
      });
      const parkedReviewActions = database.raw.prepare(`SELECT review.id,c.id AS cycleId,review.version
        FROM sales_cycles c JOIN next_actions review ON review.id=c.current_next_action_id
        WHERE ${legacyReviewParkingEligibilitySql('c')} ORDER BY review.id`).all() as WorkflowTransitionManifest['parkedReviewActions'];
      const cancelledActionIds = candidates.map(action => action.id);
      const stoppedEnrollmentIds = [...new Set(candidates.map(action => action.cadence.cadenceEnrollmentId!))].filter(id =>
        !actionSnapshots.some(action => action.cadence.cadenceEnrollmentId === id && !cancelledActionIds.includes(action.id)));
      const manifest: WorkflowTransitionManifest = { ...command, mode: 'meeting_first', revision, occurredAt, cancelledActionIds, stoppedEnrollmentIds,
        preservedActionIds: actionSnapshots.filter(a => !cancelledActionIds.includes(a.id)).map(a => a.id),
        parkedPersonIds: [...new Set(sourceIdentities.filter(source => candidates.some(a => a.salesCycleId === source.cycleId)
          || parkedReviewActions.some(a => a.cycleId === source.cycleId)).map(source => source.personId))].sort(),
        sourceIdentities, actionSnapshots, parkedReviewActions,
        enrollmentSnapshots: database.raw.prepare('SELECT id,cadence_definition_id AS definitionId,version,status,current_step_id AS currentStepId,allowed_step_ids_json AS allowedStepIdsJson FROM cadence_enrollments ORDER BY id').all() as WorkflowTransitionManifest['enrollmentSnapshots'],
        callbackEvidenceIds: (database.raw.prepare('SELECT id FROM activities WHERE callback_at IS NOT NULL ORDER BY id').all() as { id: string }[]).map(row => row.id),
        unknownDraftIds: (database.raw.prepare("SELECT id FROM email_drafts WHERE status IN('sending','unknown') ORDER BY id").all() as { id: string }[]).map(row => row.id),
        parkedActions: candidates.filter(action => cycles.getById(action.salesCycleId)?.currentNextActionId === action.id).map(action => ({ id: `parked-legacy:${command.manifestId}:${action.id}`, supersededActionId: action.id, cycleId: action.salesCycleId })),
        catalogs: database.raw.prepare('SELECT id,content_hash AS contentHash,version FROM cadence_definitions ORDER BY id').all() as WorkflowTransitionManifest['catalogs'] };
      // Receipt is visible to strict settlement validation inside this transaction only. Any failure rolls it back.
      database.raw.prepare('INSERT INTO workflow_transition_receipts(command_id,manifest_id,fingerprint,result_json,created_at) VALUES(?,?,?,?,?)').run(command.commandId, command.manifestId, fingerprint, serializeCanonical(manifest), occurredAt);
      for (const action of candidates) {
        const cycle = cycles.getById(action.salesCycleId)!;
        if (cycle.currentNextActionId === action.id) {
          const parkedId = manifest.parkedActions.find(parked => parked.supersededActionId === action.id)!.id;
          actions.insertNextAction({ id: parkedId, salesCycleId: cycle.id, actionType: 'parked_legacy', channel: null, status: 'pending', timezone: action.timezone,
            allowedWindow: null, workIntent: 'internal_review', inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null }, cadence: noCadence,
            dueAt: occurredAt, dueSource: 'internal_review', createdAt: occurredAt });
          cycles.replaceCurrentAction({ cycleId: cycle.id, expectedVersion: cycle.version, expectedStage: cycle.stage, expectedWorkflowStatus: 'active', expectedCurrentActionId: action.id, nextActionId: parkedId, updatedAt: occurredAt });
        }
        const enrollment = database.raw.prepare('SELECT scheduled_step_count FROM cadence_enrollments WHERE id=?').get(action.cadence.cadenceEnrollmentId) as { scheduled_step_count: number };
        actions.settleAction({ actionId: action.id, salesCycleId: cycle.id, expectedStatus: 'pending', expectedVersion: action.version,
          expectedWorkIntent: 'discretionary_prospecting', expectedInboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null }, expectedCadence: action.cadence,
          status: 'cancelled', completedAt: occurredAt, completionActivityId: null,
          settlement: { version: 1, outcome: 'workflow_superseded', reason: command.manifestId, evidenceActivityId: null,
            plannerTransition: { definitionId: action.cadence.cadenceDefinitionId, stepId: action.cadence.cadenceStepId, componentId: action.cadence.cadenceComponentId, attempt: enrollment.scheduled_step_count, outcome: 'workflow_superseded' },
            cadence: action.cadence, workIntent: action.workIntent, inboundSla: action.inboundSla } });
      }
      for (const enrollmentId of stoppedEnrollmentIds) {
        if (database.raw.prepare("UPDATE cadence_enrollments SET status='stopped',stop_reason='meeting_first_transition',version=version+1,updated_at=? WHERE id=? AND status='active'").run(occurredAt, enrollmentId).changes !== 1) throw new Error('Stale automatic enrollment.');
      }
      if (state) {
        if (database.raw.prepare("UPDATE workspace_workflow_state SET mode='meeting_first',revision=?,updated_at=? WHERE singleton=1 AND mode='legacy' AND revision=?").run(revision, occurredAt, state.revision).changes !== 1) throw new Error('Workflow CAS conflict.');
      } else database.raw.prepare("INSERT INTO workspace_workflow_state(singleton,mode,revision,updated_at) VALUES(1,'meeting_first',1,?)").run(occurredAt);

      return manifest;
    });
  }
}
