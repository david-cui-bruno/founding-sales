import { auditDomainInvariants } from '../../src/main/domain/lifecycle/invariantAudit';
import { copyFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { NextActionRepository } from '../../src/main/domain/lifecycle/nextActionRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { LegacyWorkflowTransition, canScheduleLegacy, readWorkflowMode } from '../../src/main/domain/workspace/legacyWorkflowTransition';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { TodayRepository } from '../../src/main/domain/today/todayRepository';
import { seedProspect, insertPerson, insertClosedCycle } from '../fixtures/domainRows';

const at = '2026-09-09T00:00:00.000Z';
async function fixture() {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const database = openDatabase({ path: temp.path, key });
  await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
  const unitOfWork = new DomainUnitOfWork(database), clock = { now: () => at };
  let counter = 0;
  const ids = { next: () => `fictional-${++counter}` };
  const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
  const events = new EventRepository({ database, unitOfWork, clock, ids });
  const sources = new SourceRepository({ database, unitOfWork, clock });
  const cadences = new CadenceRepository({ database, unitOfWork, clock });
  unitOfWork.immediate(() => cadences.installBuiltins());
  const lifecycle = new LifecycleService({ database, unitOfWork, clock, ids, identities, events, sources, cadences, timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1 });
  const transition = new LegacyWorkflowTransition({ database, unitOfWork, clock, ids });
  const actions = new NextActionRepository({ database, unitOfWork });
  const seed = (prefix: string, ready = true) => {
    const prospect = seedProspect(database.raw, prefix);
    database.raw.prepare("UPDATE prospects SET qualification_state='unreviewed',segment='cold' WHERE id=?").run(prospect.prospectId);
    const cycle = lifecycle.createUnreviewedCycle({ personId: prospect.personId, prospectId: prospect.prospectId, entrySourceEventId: prospect.sourceEventId, effectiveAt: at });
    const result = ready ? lifecycle.reviewToReady({ cycleId: cycle.id, expectedCycleVersion: 1, expectedProspectVersion: 1, effectiveAt: at }) : cycle;
    database.raw.prepare("UPDATE prospects SET segment='warm' WHERE id=?").run(prospect.prospectId);
    return result;
  };
  return { database, unitOfWork, transition, actions, events, sources, lifecycle, seed, temp, key };
}
const command = { commandId: 'transition-command', expectedMode: 'legacy' as const, manifestId: 'manifest-1' };
describe('explicit persisted meeting-first transition', () => {
  it('gates only automatic legacy acquisition, absent mode stays legacy', () => {
    expect(canScheduleLegacy({ mode: null, kind: 'automatic_acquisition' })).toBe(true);
    expect(canScheduleLegacy({ mode: 'meeting_first', kind: 'automatic_acquisition' })).toBe(false);
    expect(canScheduleLegacy({ mode: 'meeting_first', kind: 'recorded_promise' })).toBe(true);
  });
  it('atomically parks proven automatic work, preserves callbacks/catalog/history, and replays after reopen', async () => {
    const f = await fixture();
    let db = f.database;
    try {
      expect(readWorkflowMode(db)).toBe('legacy');
      expect(db.raw.prepare('SELECT * FROM workspace_workflow_state').all()).toEqual([]);
      const automatic = f.seed('automatic'), callback = f.seed('callback'), unreviewed = f.seed('unresolved', false);
      db.raw.prepare("UPDATE next_actions SET due_source='recorded_callback' WHERE id=?").run(callback.currentNextActionId);
      const callbackBefore = f.actions.getById(callback.currentNextActionId!);
      const catalogsBefore = db.raw.prepare('SELECT * FROM cadence_definitions ORDER BY id').all();
      const historyBefore = db.raw.prepare('SELECT * FROM stage_events ORDER BY id').all();
      const manifest = f.transition.transitionWorkflow(command);
      expect(manifest).toMatchObject({ mode: 'meeting_first', revision: 1, cancelledActionIds: [automatic.currentNextActionId], preservedActionIds: expect.arrayContaining([callback.currentNextActionId]), parkedPersonIds: expect.arrayContaining([unreviewed.personId]) });
      expect(f.actions.getById(automatic.currentNextActionId!)?.status).toBe('cancelled');
      expect(f.actions.getById(callback.currentNextActionId!)).toEqual(callbackBefore);
      expect(db.raw.prepare('SELECT * FROM cadence_definitions ORDER BY id').all()).toEqual(catalogsBefore);
      expect(db.raw.prepare('SELECT * FROM stage_events ORDER BY id').all()).toEqual(historyBefore);
      expect(db.raw.prepare('SELECT * FROM campaign_enrollments').all()).toEqual([]);
      expect(() => f.lifecycle.reviewToReady({ cycleId: unreviewed.id, expectedCycleVersion: 1, expectedProspectVersion: 1, effectiveAt: at })).toThrow(/legacy|meeting.first/i);
      expect(f.transition.transitionWorkflow(command)).toEqual(manifest);
      expect(() => f.transition.transitionWorkflow({ ...command, manifestId: 'changed' })).toThrow();
      expect(() => f.transition.transitionWorkflow({ ...command, commandId: 'stale', manifestId: 'stale' })).toThrow();
      closeDatabase(db);
      copyFileSync(f.temp.path, `${f.temp.path}.restored`);
      db = openDatabase({ path: `${f.temp.path}.restored`, key: f.key });
      const restored = new LegacyWorkflowTransition({ database: db, unitOfWork: new DomainUnitOfWork(db), clock: { now: () => at }, ids: { next: () => 'must-not-allocate' } });
      expect(readWorkflowMode(db)).toBe('meeting_first');
      expect(restored.transitionWorkflow(command)).toEqual(manifest);
      expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const ownedIds = new Set([automatic.id, callback.id, unreviewed.id, ...manifest.actionSnapshots.map(action => action.id), ...manifest.enrollmentSnapshots.map(enrollment => enrollment.id), ...manifest.parkedActions.map(action => action.id)]);
      expect(auditDomainInvariants({ database: db, asOf: at }).filter(issue => ownedIds.has(issue.recordId))).toEqual([]);
    } finally { closeDatabase(db); f.temp.cleanup(); }
  });
  it('rolls the receipt, cancellations and mode back together if the final CAS write fails', async () => {
    const f = await fixture();
    try {
      const cycle = f.seed('rollback');
      const before = f.actions.getById(cycle.currentNextActionId!);
      f.database.raw.exec("CREATE TRIGGER fictional_fail_mode BEFORE INSERT ON workspace_workflow_state BEGIN SELECT RAISE(ABORT,'fictional mode failure'); END");
      expect(() => f.transition.transitionWorkflow(command)).toThrow('fictional mode failure');
      expect(f.database.raw.prepare('SELECT * FROM workflow_transition_receipts').all()).toEqual([]);
      expect(f.actions.getById(cycle.currentNextActionId!)).toEqual(before);
      expect(readWorkflowMode(f.database)).toBe('legacy');
      expect(f.database.raw.prepare("SELECT * FROM next_actions WHERE action_type='parked_legacy'").all()).toEqual([]);
    } finally { closeDatabase(f.database); f.temp.cleanup(); }
  });
  it('parked work contributes no Today items or warm capacity while preserved callback remains actionable', async () => {
    const f = await fixture();
    try {
      const auto = f.seed('parked');
      const unresolved = f.seed('parked-unresolved', false);
      const oldReview = f.actions.getById(unresolved.currentNextActionId!)!;
      const today = new TodayRepository({ database: f.database, unitOfWork: f.unitOfWork });
      expect(today.hasActiveWarm()).toBe(true);
      f.transition.transitionWorkflow(command);
      expect(today.hasActiveWarm()).toBe(false);
      expect(today.listOperationalCandidates()).toEqual([]);
      expect(f.database.raw.prepare('SELECT stage FROM sales_cycles WHERE id=?').get(auto.id)).toEqual({ stage: 'ready' });
      expect(f.actions.getById(oldReview.id)).toEqual(oldReview);
      const futureReview = f.seed('future-review', false);
      expect(today.listOperationalCandidates()).toHaveLength(1);
      expect(() => f.lifecycle.reviewToReady({ cycleId: futureReview.id, expectedCycleVersion: futureReview.version, expectedProspectVersion: 1, effectiveAt: at })).toThrow(/Meeting-first/);
      // A later genuine obligation on the same identity must not inherit legacy parking.
      f.database.raw.prepare("UPDATE next_actions SET due_source='recorded_callback',version=version+1 WHERE id=?").run(oldReview.id);
      expect(today.hasActiveWarm()).toBe(true);
      expect(today.listOperationalCandidates()).toHaveLength(2);
    } finally { closeDatabase(f.database); f.temp.cleanup(); }
  });
  it('completes preserved callback evidence without restarting automatic acquisition', async () => {
    const f = await fixture();
    try {
      const cycle = f.seed('promised');
      f.database.raw.prepare("UPDATE next_actions SET due_source='recorded_callback' WHERE id=?").run(cycle.currentNextActionId);
      const action = f.actions.getById(cycle.currentNextActionId!)!;
      f.transition.transitionWorkflow(command);
      const today = new TodayRepository({ database: f.database, unitOfWork: f.unitOfWork });
      expect(today.hasActiveWarm()).toBe(true);
      expect(today.listOperationalCandidates()).toHaveLength(1);
      f.unitOfWork.immediate(() => f.events.appendActivity({ id: 'fictional-no-answer', personId: cycle.personId, prospectId: cycle.prospectId,
        salesCycleId: cycle.id, cadenceEnrollmentId: action.cadence.cadenceEnrollmentId, cadenceStepId: action.cadence.cadenceStepId,
        cadenceComponentId: action.cadence.cadenceComponentId, kind: 'call', direction: 'outbound', channel: 'phone', occurredAt: at, observedOutcome: 'no_answer', metadata: {} }));
      const result = f.lifecycle.completeCurrentAction({ cycleId: cycle.id, expectedCycleVersion: cycle.version, expectedCurrentActionId: action.id,
        expectedActionVersion: action.version, expectedEnrollmentVersion: 1, outcome: 'no_answer', activityId: 'fictional-no-answer', impossibleDisposition: null,
        evaluationAt: at, manualReactivationDueAt: null });
      expect(f.actions.getById(action.id)).toMatchObject({ status: 'completed', completionActivityId: 'fictional-no-answer' });
      expect(f.actions.getById(result.currentNextActionId!)).toMatchObject({ actionType: 'parked_legacy', channel: null });
      expect(today.listOperationalCandidates()).toEqual([]);
      expect(today.hasActiveWarm()).toBe(false);
    } finally { closeDatabase(f.database); f.temp.cleanup(); }
  });

  it.each(['promised', 'inbound'] as const)('restores the same owed %s component after resolving a preserved contact method', async kind => {
    const f = await fixture();
    try {
      let cycle;
      if (kind === 'promised') {
        cycle = f.seed('resolver-promise');
        f.database.raw.prepare("UPDATE next_actions SET due_source='recorded_callback' WHERE id=?").run(cycle.currentNextActionId);
      } else {
        const prospect = seedProspect(f.database.raw, 'resolver-inbound');
        const sourceCycleId = insertClosedCycle({ database: f.database.raw, prefix: 'resolver-history', prospect });
        f.unitOfWork.immediate(() => f.sources.append({ id: 'explicit-inbound-demo', personId: prospect.personId, prospectId: prospect.prospectId,
          channel: 'inbound_demo', observedAt: at, sourceRecord: { message: 'Please respond' } }));
        const definition = BUILTIN_CADENCES.find(c => c.family === 'cadence_c')!;
        f.lifecycle.reactivateFromInboundResponse({ evidence: { kind: 'source_event', sourceEventId: 'explicit-inbound-demo', channel: 'inbound_demo' },
          personId: prospect.personId, prospectId: prospect.prospectId, sourceCycleId, newCycleId: 'resolver-inbound-cycle', activatedAt: at,
          cadence: { definitionId: definition.id, family: 'cadence_c', version: definition.version, contentHash: definition.contentHash } });
        cycle = f.database.raw.prepare('SELECT id,version,current_next_action_id AS currentNextActionId,person_id AS personId,prospect_id AS prospectId FROM sales_cycles WHERE id=?').get('resolver-inbound-cycle') as ReturnType<typeof f.seed>;
      }
      const action = f.actions.getById(cycle.currentNextActionId!)!;
      if (kind === 'promised') f.database.raw.prepare(`INSERT INTO activities(id,person_id,prospect_id,sales_cycle_id,kind,direction,channel,occurred_at,metadata_json,created_at,callback_at)
        VALUES('resolver-callback-evidence',?,?,?,'call','outbound','phone',?,'{}',?,?)`).run(cycle.personId, cycle.prospectId, cycle.id, at, at, at);
      f.unitOfWork.immediate(() => f.events.appendActivity({ id: 'unavailable-owed', personId: cycle.personId, prospectId: cycle.prospectId, salesCycleId: cycle.id,
        cadenceEnrollmentId: action.cadence.cadenceEnrollmentId, cadenceStepId: action.cadence.cadenceStepId, cadenceComponentId: action.cadence.cadenceComponentId,
        kind: action.channel === 'phone' ? 'call' : 'text', direction: 'outbound', channel: action.channel!, occurredAt: at, observedOutcome: 'channel_unavailable', metadata: {} }));
      const blocked = f.lifecycle.completeCurrentAction({ cycleId: cycle.id, expectedCycleVersion: cycle.version, expectedCurrentActionId: action.id,
        expectedActionVersion: action.version, expectedEnrollmentVersion: 1, outcome: 'channel_unavailable', activityId: 'unavailable-owed', impossibleDisposition: null,
        evaluationAt: at, manualReactivationDueAt: null });
      const resolver = f.actions.getById(blocked.currentNextActionId!)!;
      expect(resolver.actionType).toBe('resolve_contact_method');
      f.transition.transitionWorkflow(command);
      const restored = f.lifecycle.completeCurrentAction({ cycleId: cycle.id, expectedCycleVersion: blocked.version, expectedCurrentActionId: resolver.id,
        expectedActionVersion: resolver.version, expectedEnrollmentVersion: 2, outcome: 'resolved', activityId: null, impossibleDisposition: null,
        evaluationAt: at, manualReactivationDueAt: null });
      expect(f.actions.getById(restored.currentNextActionId!)).toMatchObject({ actionType: action.actionType, channel: action.channel,
        workIntent: action.workIntent, inboundSla: action.inboundSla, cadence: action.cadence, status: 'pending' });
      expect(f.database.raw.prepare('SELECT status FROM cadence_enrollments WHERE id=?').get(action.cadence.cadenceEnrollmentId)).toEqual({ status: 'active' });
      expect(new TodayRepository({ database: f.database, unitOfWork: f.unitOfWork }).listOperationalCandidates()).toHaveLength(1);
      const owed = f.actions.getById(restored.currentNextActionId!)!;
      const outcome = owed.channel === 'phone' ? 'no_answer' : 'accepted';
      f.unitOfWork.immediate(() => f.events.appendActivity({ id: 'owed-fulfilled', personId: cycle.personId, prospectId: cycle.prospectId, salesCycleId: cycle.id,
        cadenceEnrollmentId: owed.cadence.cadenceEnrollmentId, cadenceStepId: owed.cadence.cadenceStepId, cadenceComponentId: owed.cadence.cadenceComponentId,
        kind: owed.channel === 'phone' ? 'call' : 'text', direction: 'outbound', channel: owed.channel!, occurredAt: at, observedOutcome: outcome, metadata: {} }));
      const settled = f.lifecycle.completeCurrentAction({ cycleId: cycle.id, expectedCycleVersion: restored.version, expectedCurrentActionId: owed.id,
        expectedActionVersion: owed.version, expectedEnrollmentVersion: 3, outcome, activityId: 'owed-fulfilled', impossibleDisposition: null,
        evaluationAt: at, manualReactivationDueAt: null });
      expect(f.actions.getById(owed.id)).toMatchObject({ status: 'completed', completionActivityId: 'owed-fulfilled' });
      expect(f.actions.getById(settled.currentNextActionId!)).toMatchObject({ actionType: 'parked_legacy' });
      expect(f.database.raw.prepare('SELECT status FROM cadence_enrollments WHERE id=?').get(action.cadence.cadenceEnrollmentId)).toEqual({ status: 'stopped' });
    } finally { closeDatabase(f.database); f.temp.cleanup(); }
  });

  it.each(['callback', 'inbound'] as const)('does not manifest-park an unresolved review with real %s evidence', async kind => {
    const f = await fixture();
    try {
      const cycle = f.seed(`unresolved-${kind}`, false);
      if (kind === 'callback') f.database.raw.prepare(`INSERT INTO activities(id,person_id,prospect_id,sales_cycle_id,kind,direction,channel,occurred_at,metadata_json,created_at,callback_at)
        VALUES('review-callback',?,?,?,'call','outbound','phone',?,'{}',?,?)`).run(cycle.personId, cycle.prospectId, cycle.id, at, at, at);
      else f.unitOfWork.immediate(() => f.sources.append({ id: 'review-inbound-evidence', personId: cycle.personId, prospectId: cycle.prospectId,
        channel: 'inbound_demo', observedAt: at, sourceRecord: { message: 'Please respond' } }));
      const actionBefore = f.actions.getById(cycle.currentNextActionId!);
      const manifest = f.transition.transitionWorkflow(command);
      expect(manifest.parkedReviewActions).toEqual([]);
      expect(manifest.parkedPersonIds).not.toContain(cycle.personId);
      expect(f.actions.getById(cycle.currentNextActionId!)).toEqual(actionBefore);
      const today = new TodayRepository({ database: f.database, unitOfWork: f.unitOfWork });
      expect(today.hasActiveWarm()).toBe(true);
      expect(today.listOperationalCandidates()).toHaveLength(1);
    } finally { closeDatabase(f.database); f.temp.cleanup(); }
  });

  it('preserves callback Activity evidence even when old action labels never changed', async () => {
    const f = await fixture();
    try {
      const cycle = f.seed('activity-callback');
      f.database.raw.prepare(`INSERT INTO activities(id,person_id,prospect_id,sales_cycle_id,kind,direction,channel,occurred_at,metadata_json,created_at,note_text,callback_at)
        VALUES('callback-evidence',?,?,?,'call','outbound','phone',?,'{}',?,'Actual promised callback',?)`).run(cycle.personId, cycle.prospectId, cycle.id, at, at, '2026-09-10T12:00:00.000Z');
      const before = f.actions.getById(cycle.currentNextActionId!);
      expect(f.transition.transitionWorkflow(command).cancelledActionIds).toEqual([]);
      expect(f.actions.getById(cycle.currentNextActionId!)).toEqual(before);
    } finally { closeDatabase(f.database); f.temp.cleanup(); }
  });

  it('preserves saved drafts, unknown send evidence and suppression through explicit transition', async () => {
    const f = await fixture();
    try {
      const cycle = f.seed('uncertain-send');
      f.database.raw.prepare(`INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,raw_value,validation_state,reachability,created_at,updated_at)
        VALUES('saved-email',?,'email','saved@example.invalid','saved@example.invalid','valid','direct',?,?)`).run(cycle.personId, at, at);
      for (const [id, status] of [['saved-draft', 'draft'], ['unknown-draft', 'unknown']]) {
        f.database.raw.prepare(`INSERT INTO email_drafts(id,person_id,sales_cycle_id,contact_method_id,recipient,contact_snapshot,subject,body,revision,status,generation,created_at,updated_at,superseded_at)
          VALUES(?,?,?,'saved-email','saved@example.invalid',?,'Original exact subject','Original old positioning text',1,?,'edited',?,?,?)`).run(id, cycle.personId, cycle.id, 'a'.repeat(64), status, at, at, id === 'saved-draft' ? at : null);
      }
      f.database.raw.prepare('INSERT INTO email_send_intents VALUES(?,?,?,?,?,?)').run('unknown-send', 'unknown-draft', 1, 'b'.repeat(64), '{"uncertain":true}', at);
      f.database.raw.prepare('INSERT INTO email_send_results VALUES(?,?,?,?)').run('unknown-send', 'unknown', '{"status":"unknown","providerReference":null}', at);
      insertPerson(f.database.raw, 'opted-out-person');
      f.database.raw.prepare(`INSERT INTO activities(id,person_id,kind,direction,channel,occurred_at,metadata_json,created_at)
        VALUES('optout-evidence',?,'opt_out','inbound','manual',?,'{}',?)`).run('opted-out-person', at, at);
      f.database.raw.prepare('INSERT INTO opt_out_tombstones VALUES(?,?,?,?,?,?,?,?)').run('optout', 'opted-out-person', at, 'manual', 'optout-evidence', 'fictional-optout', 'policy', at);
      f.database.raw.prepare('INSERT INTO opt_out_handles VALUES(?,?,?,?,?)').run('optout-handle', 'optout', 'email', 'saved@example.invalid', at);
      const preserved = ['email_drafts', 'email_send_intents', 'email_send_results', 'opt_out_tombstones', 'opt_out_handles', 'activities'];
      const snapshot = () => preserved.map(table => f.database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const before = snapshot(), actionBefore = f.actions.getById(cycle.currentNextActionId!);
      expect(f.transition.transitionWorkflow(command).cancelledActionIds).toEqual([]);
      expect(snapshot()).toEqual(before);
      expect(f.actions.getById(cycle.currentNextActionId!)).toEqual(actionBefore);
      expect(() => f.database.raw.prepare("UPDATE workflow_transition_receipts SET result_json='{}'").run()).toThrow();
    } finally { closeDatabase(f.database); f.temp.cleanup(); }
  });

  it('blocks persisted automatic reactivation and live-vacancy upgrades after explicit transition', async () => {
    const f = await fixture();
    try {
      const prospect = seedProspect(f.database.raw, 'historical-reactivation');
      const sourceCycleId = insertClosedCycle({ database: f.database.raw, prefix: 'historical-reactivation', prospect });
      f.database.raw.prepare("INSERT INTO reactivation_rules(id,sales_cycle_id,rule_type,due_at,version,created_at) VALUES('seasonal-rule',?,'seasonal:heating-oct1',?,1,?)").run(sourceCycleId, at, at);
      const definition = BUILTIN_CADENCES.find(c => c.family === 'cadence_c')!;
      const active = f.seed('upgrade');
      f.transition.transitionWorkflow(command);
      expect(() => f.lifecycle.reactivateFromRule({ ruleId: 'seasonal-rule', expectedRuleVersion: 1, personId: prospect.personId, prospectId: prospect.prospectId,
        sourceCycleId, entrySourceEventId: prospect.sourceEventId, newCycleId: 'must-not-exist', activatedAt: at, ruleType: 'seasonal:heating-oct1', trigger: { kind: 'due', dueAt: at },
        cadence: { definitionId: definition.id, family: 'cadence_c', version: definition.version, contentHash: definition.contentHash } })).toThrow(/Meeting-first/);
      expect(f.database.raw.prepare("SELECT consumed_at FROM reactivation_rules WHERE id='seasonal-rule'").get()).toEqual({ consumed_at: null });
      expect(f.database.raw.prepare("SELECT id FROM sales_cycles WHERE id='must-not-exist'").get()).toBeUndefined();
      expect(() => f.lifecycle.applyProspectingTrigger({ cycleId: active.id, expectedCycleVersion: active.version, expectedCurrentActionId: active.currentNextActionId!,
        expectedActionVersion: 1, expectedEnrollmentVersion: 1, triggerSourceEventId: active.entrySourceEventId, trigger: 'live_vacancy', evaluationAt: at })).toThrow(/Meeting-first/);
    } finally { closeDatabase(f.database); f.temp.cleanup(); }
  });

});
