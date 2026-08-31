import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { canonicalJson, type CadenceFamily } from '../../src/main/domain/cadence/cadenceTypes';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import type { CompleteCurrentActionInput } from '../../src/main/domain/lifecycle/lifecycleTransactionWriter';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { StaleDomainWriteError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { spawnLifecycleCommandWorker } from '../support/domainWriteWorker';

const MANUAL_DUE = '2026-10-15T13:00:00.000Z';

type TerminalCase = Readonly<{
  name: string;
  family: CadenceFamily;
  stage: 'contacted' | 'interviewed' | 'offered' | 'won';
  workflowStatus: 'active' | 'onboarding';
  stepIndex: number;
  componentIndex?: number;
  mode?: 'standard' | 'inbound_over_cap_response';
  actionType?: string;
  actionChannel?: string | null;
  workIntent: 'discretionary_prospecting' | 'promised_follow_up' | 'inbound_response';
  outcome: CompleteCurrentActionInput['outcome'];
  impossibleDisposition: CompleteCurrentActionInput['impossibleDisposition'];
  workerIds: readonly string[];
  terminal: 'replacement' | 'closed_won' | 'closed_lost';
  manualReactivationDueAt: string | null;
}>;

const CASES: readonly TerminalCase[] = [
  {
    name: 'post-interview phase completion', family: 'post_interview',
    stage: 'interviewed', workflowStatus: 'active', stepIndex: 1,
    workIntent: 'promised_follow_up', outcome: 'answered', impossibleDisposition: null,
    workerIds: ['worker-confirm-offer'], terminal: 'replacement',
    manualReactivationDueAt: null,
  },
  {
    name: 'onboarding phase completion', family: 'onboarding', stage: 'won',
    workflowStatus: 'onboarding', stepIndex: 0, componentIndex: 2,
    workIntent: 'promised_follow_up', outcome: 'accepted', impossibleDisposition: null,
    workerIds: [], terminal: 'closed_won', manualReactivationDueAt: null,
  },
  {
    name: 'inbound over-cap handled', family: 'cadence_c', stage: 'contacted',
    workflowStatus: 'active', stepIndex: 0, mode: 'inbound_over_cap_response',
    workIntent: 'inbound_response', outcome: 'accepted', impossibleDisposition: null,
    workerIds: ['worker-book-follow-up'], terminal: 'replacement',
    manualReactivationDueAt: null,
  },
  {
    name: 'inbound over-cap impossible', family: 'cadence_c', stage: 'contacted',
    workflowStatus: 'active', stepIndex: 0, mode: 'inbound_over_cap_response',
    actionType: 'resolve_contact_method', actionChannel: null,
    workIntent: 'inbound_response', outcome: 'marked_impossible',
    impossibleDisposition: { reason: 'missing_phone', notes: null },
    workerIds: ['worker-review-inbound'], terminal: 'replacement',
    manualReactivationDueAt: null,
  },
  {
    name: 'prospecting breakup exhaustion', family: 'cadence_a', stage: 'contacted',
    workflowStatus: 'active', stepIndex: 7, workIntent: 'discretionary_prospecting',
    outcome: 'accepted', impossibleDisposition: null,
    workerIds: ['worker-seasonal', 'worker-frbo', 'worker-lost-event'],
    terminal: 'closed_lost', manualReactivationDueAt: null,
  },
  {
    name: 'post-offer breakup exhaustion', family: 'post_offer', stage: 'offered',
    workflowStatus: 'active', stepIndex: 4, workIntent: 'promised_follow_up',
    outcome: 'accepted', impossibleDisposition: null,
    workerIds: ['worker-manual', 'worker-offer-lost-event'],
    terminal: 'closed_lost', manualReactivationDueAt: MANUAL_DUE,
  },
];

describe('independent encrypted terminal branch races', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  it.each(CASES.flatMap((terminalCase) => ([
    { terminalCase, loser: 'same' as const },
    { terminalCase, loser: 'stale_alternate' as const },
  ])))('$terminalCase.name rejects a $loser contender without duplicate terminal work', async ({
    terminalCase, loser,
  }) => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    let loserIdCount = 0;
    const loserIds = { next: () => `loser-unexpected-${++loserIdCount}` };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids: loserIds });
    const events = new EventRepository({ database, unitOfWork, clock, ids: loserIds });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids: loserIds,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    const seeded = seedRaceTerminal(database, terminalCase);
    unitOfWork.immediate(() => events.appendActivity({
      id: seeded.activityId, personId: seeded.personId, prospectId: seeded.prospectId,
      salesCycleId: seeded.cycleId, cadenceEnrollmentId: seeded.enrollmentId,
      cadenceStepId: seeded.stepId, cadenceComponentId: seeded.componentId,
      kind: seeded.actionKind, direction: 'outbound', channel: seeded.componentChannel,
      occurredAt: DOMAIN_TIMESTAMP, observedOutcome: terminalCase.outcome, metadata: {},
    }));
    const winnerCommand: CompleteCurrentActionInput = {
      cycleId: seeded.cycleId, expectedCycleVersion: 1,
      expectedCurrentActionId: seeded.actionId, expectedActionVersion: 1,
      expectedEnrollmentVersion: 1, outcome: terminalCase.outcome,
      activityId: seeded.activityId,
      impossibleDisposition: terminalCase.impossibleDisposition,
      evaluationAt: DOMAIN_TIMESTAMP,
      manualReactivationDueAt: terminalCase.manualReactivationDueAt,
    };
    const readyPath = `${workspace.path}.${terminalCase.family}.${loser}.ready`;
    const worker = spawnLifecycleCommandWorker({
      databasePath: workspace.path, keyHex: key.bytes.toString('hex'), readyPath,
      ids: terminalCase.workerIds, timestamp: DOMAIN_TIMESTAMP,
      command: winnerCommand as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    const losingCommand: CompleteCurrentActionInput = loser === 'same'
      ? winnerCommand
      : {
        ...winnerCommand,
        outcome: terminalCase.outcome === 'marked_impossible' ? 'accepted' : 'marked_impossible',
        impossibleDisposition: terminalCase.outcome === 'marked_impossible'
          ? null : { reason: 'missing_phone', notes: null },
      };

    expect(() => service.completeCurrentAction(losingCommand)).toThrow(StaleDomainWriteError);
    expect(await exit).toEqual({ code: 0, stderr: '' });
    expect(loserIdCount).toBe(0);
    const cycle = database.raw.prepare(`
      SELECT stage, workflow_status, current_next_action_id, version
      FROM sales_cycles WHERE id = ?
    `).get(seeded.cycleId) as {
      stage: string; workflow_status: string; current_next_action_id: string | null; version: number;
    };
    expect(cycle.version).toBe(2);
    if (terminalCase.terminal === 'replacement') {
      expect(cycle.workflow_status).toBe('active');
      expect(cycle.current_next_action_id).toBe(terminalCase.workerIds[0]);
      expect(database.raw.prepare(`
        SELECT COUNT(*) AS count FROM next_actions
        WHERE sales_cycle_id = ? AND status = 'pending'
      `).get(seeded.cycleId)).toEqual({ count: 1 });
    } else {
      expect(cycle.current_next_action_id).toBeNull();
      expect(cycle.workflow_status).toBe('closed');
      expect(cycle.stage).toBe(terminalCase.terminal === 'closed_won' ? 'won' : 'lost_nurture');
    }
    expect(database.raw.prepare(`
      SELECT COUNT(*) AS count FROM next_actions
      WHERE sales_cycle_id = ? AND id <> ?
    `).get(seeded.cycleId, seeded.actionId)).toEqual({
      count: terminalCase.terminal === 'replacement' ? 1 : 0,
    });
  }, 15_000);
});

function seedRaceTerminal(database: AppDatabase, input: TerminalCase): Readonly<{
  personId: string; prospectId: string; cycleId: string; enrollmentId: string;
  actionId: string; activityId: string; stepId: string; componentId: string;
  componentChannel: string; actionKind: 'call' | 'voicemail' | 'text' | 'email';
}> {
  const prefix = `race-${input.family}-${input.outcome}`;
  const prospect = seedProspect(database.raw, prefix);
  const definition = BUILTIN_CADENCES.find(({ family }) => family === input.family)!;
  const step = definition.steps[input.stepIndex]!;
  const component = step.components[input.componentIndex ?? 0]!;
  const cycleId = `${prefix}-cycle`;
  const enrollmentId = `${prefix}-enrollment`;
  const actionId = `${prefix}-action`;
  const activityId = `${prefix}-activity`;
  const mode = input.mode ?? 'standard';
  const inboundSourceId = input.workIntent === 'inbound_response'
    ? `${prefix}-referral-source` : null;
  database.raw.exec('BEGIN IMMEDIATE');
  try {
    if (inboundSourceId !== null) {
      database.raw.prepare(`
        INSERT INTO source_events (
          id, person_id, prospect_id, channel, observed_at, source_record_json,
          referrer_unknown_reason, created_at
        ) VALUES (?, ?, ?, 'referral', ?, ?, 'not_provided', ?)
      `).run(inboundSourceId, prospect.personId, prospect.prospectId, DOMAIN_TIMESTAMP,
        canonicalJson({
          formatVersion: 1, sourceRecord: { race: true }, customSourceReason: null,
        }), DOMAIN_TIMESTAMP);
    }
    database.raw.prepare(`
      INSERT INTO sales_cycles (
        id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
        current_next_action_id, stage_entered_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(cycleId, prospect.personId, prospect.prospectId, prospect.sourceEventId,
      input.stage, input.workflowStatus, actionId, DOMAIN_TIMESTAMP,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    if (mode === 'inbound_over_cap_response') {
      database.raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
          version, stop_reason, created_at, updated_at
        ) VALUES (?, ?, ?, 'stopped', ?, ?, ?, 'standard', NULL, 1,
          'upgraded', ?, ?)
      `).run(`${enrollmentId}-prior`, cycleId, definition.id, DOMAIN_TIMESTAMP,
        definition.steps.at(-1)!.id, definition.attemptCap,
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    }
    database.raw.prepare(`
      INSERT INTO cadence_enrollments (
        id, sales_cycle_id, cadence_definition_id, status, anchor_at,
        current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
        version, stop_reason, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 1, NULL, ?, ?)
    `).run(enrollmentId, cycleId, definition.id, DOMAIN_TIMESTAMP, step.id,
      mode === 'inbound_over_cap_response' ? 1 : input.stepIndex + 1, mode,
      mode === 'inbound_over_cap_response' ? canonicalJson([step.id]) : null,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const inboundDue = inboundSourceId === null ? null : '2026-09-01T12:00:00.000Z';
    database.raw.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status, due_at, timezone,
        allowed_window, work_intent, sla_due_at, inbound_sla_kind,
        inbound_sla_due_at, inbound_sla_source_event_id, inbound_sla_provenance_json,
        cadence_enrollment_id, cadence_step_id, cadence_component_id,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, 'America/New_York', ?, ?, NULL,
        ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      actionId, cycleId, input.actionType ?? component.actionType,
      input.actionChannel === undefined ? component.channel : input.actionChannel,
      DOMAIN_TIMESTAMP, component.actionType === 'call' ? 'afternoon' : 'founder_text_v1:sunday',
      input.workIntent,
      inboundSourceId === null ? null : 'direct_referral_elapsed', inboundDue,
      inboundSourceId,
      inboundSourceId === null ? null : canonicalJson({
        version: 1, sourceEventId: inboundSourceId, sourceObservedAt: DOMAIN_TIMESTAMP,
        calculation: 'elapsed_hours', hours: 48, policyId: null, computedDueAt: inboundDue,
      }),
      enrollmentId, step.id, component.id, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
    );
    if (input.stage === 'won') {
      database.raw.prepare(`
        INSERT INTO won_terms (
          sales_cycle_id, doors_committed, billing_model, unit_rate_cents,
          projected_mrr_cents, projection_formula_version, manual_projection_reason,
          founding_customer, effective_at, created_at
        ) VALUES (?, 2, 'per_door_monthly', 5000, 10000,
          'founder_terms_v1', NULL, 1, ?, ?)
      `).run(cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    }
    database.raw.exec('COMMIT');
  } catch (error) {
    if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
    throw error;
  }
  return {
    personId: prospect.personId, prospectId: prospect.prospectId,
    cycleId, enrollmentId, actionId, activityId, stepId: step.id,
    componentId: component.id, componentChannel: component.channel,
    actionKind: component.actionType,
  };
}

function captureExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for lifecycle contender lock.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
