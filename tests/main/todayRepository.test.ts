import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { TodayRepository } from '../../src/main/domain/today/todayRepository';
import {
  DomainRepositoryDatabaseMismatchError,
} from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect, type SeededProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const DAY_START = '2026-08-30T04:00:00.000Z';
const DAY_END = '2026-08-31T04:00:00.000Z';

describe('TodayRepository', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let repository: TodayRepository;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    repository = new TodayRepository({ database, unitOfWork });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function withDeferredTransaction(operation: () => void): void {
    database.raw.exec('BEGIN IMMEDIATE');
    try {
      operation();
      database.raw.exec('COMMIT');
    } catch (error) {
      if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
      throw error;
    }
  }

  function insertCycleRow(input: {
    prefix: string;
    prospect: SeededProspect;
    workflowStatus?: 'active' | 'onboarding' | 'closed';
    stage?: string;
    pointer?: string | null;
  }): { cycleId: string; actionId: string } {
    const cycleId = `${input.prefix}-cycle`;
    const actionId = `${input.prefix}-action`;
    database.raw.prepare(`
      INSERT INTO sales_cycles (
        id, person_id, prospect_id, entry_source_event_id, stage,
        workflow_status, current_next_action_id, stage_entered_at,
        close_reason, closed_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      cycleId,
      input.prospect.personId,
      input.prospect.prospectId,
      input.prospect.sourceEventId,
      input.stage ?? 'ready',
      input.workflowStatus ?? 'active',
      input.pointer === undefined ? actionId : input.pointer,
      DOMAIN_TIMESTAMP,
      input.workflowStatus === 'closed' ? 'no_response' : null,
      input.workflowStatus === 'closed' ? DOMAIN_TIMESTAMP : null,
      DOMAIN_TIMESTAMP,
      DOMAIN_TIMESTAMP,
    );
    return { cycleId, actionId };
  }

  function insertActionRow(input: {
    id: string;
    cycleId: string;
    workIntent?: string;
    status?: string;
    actionType?: string;
    channel?: string | null;
  }): void {
    database.raw.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status,
        timezone, work_intent, created_at
      ) VALUES (?, ?, ?, ?, ?, 'America/New_York', ?, ?)
    `).run(
      input.id,
      input.cycleId,
      input.actionType ?? 'call',
      input.channel === undefined ? 'phone' : input.channel,
      input.status ?? 'pending',
      input.workIntent ?? 'discretionary_prospecting',
      DOMAIN_TIMESTAMP,
    );
  }

  function insertCycleWithAction(input: {
    prefix: string;
    prospect: SeededProspect;
    workflowStatus?: 'active' | 'onboarding' | 'closed';
    stage?: string;
    workIntent?: string;
    actionType?: string;
    channel?: string | null;
  }): { cycleId: string; actionId: string } {
    let result: { cycleId: string; actionId: string } = { cycleId: '', actionId: '' };
    withDeferredTransaction(() => {
      result = insertCycleRow(input);
      insertActionRow({
        id: result.actionId,
        cycleId: result.cycleId,
        workIntent: input.workIntent,
        actionType: input.actionType,
        channel: input.channel,
      });
    });
    return result;
  }

  it('requires the exact binding identity', () => {
    const other = new DomainUnitOfWork(database);
    expect(() => repository.assertBoundTo(database, other))
      .toThrow(DomainRepositoryDatabaseMismatchError);
  });

  it('returns only the authoritative action among supplemental pending rows', () => {
    const prospect = seedProspect(database.raw, 'authoritative');
    const { cycleId, actionId } = insertCycleWithAction({ prefix: 'authoritative', prospect });
    insertActionRow({ id: 'authoritative-older', cycleId });
    insertActionRow({ id: 'authoritative-newer', cycleId });
    const results = repository.listOperationalCandidates();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'candidate',
      candidate: { cycleId, action: { id: actionId } },
    });
  });

  it('produces typed diagnostics for missing, settled, and dangling pointers', () => {
    // The schema CHECK forbids a null operational pointer, so the missing
    // case is unrepresentable in SQL; the repository branch remains
    // defense-in-depth. Simulate the remaining corruptions by relaxing
    // enforcement exactly as other raw-corruption probes do.
    database.raw.exec('PRAGMA foreign_keys = OFF');
    for (const name of database.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger'
       AND (sql LIKE '%sales_cycles%' OR sql LIKE '%next_actions%')`,
    ).all() as { name: string }[]) {
      database.raw.exec(`DROP TRIGGER ${name.name}`);
    }
    const dangling = seedProspect(database.raw, 'pointer-dangling');
    withDeferredTransaction(() => {
      insertCycleRow({ prefix: 'pointer-dangling', prospect: dangling, pointer: 'not-a-row' });
    });
    const settled = seedProspect(database.raw, 'pointer-settled');
    withDeferredTransaction(() => {
      const settledCycle = insertCycleRow({ prefix: 'pointer-settled', prospect: settled });
      insertActionRow({ id: settledCycle.actionId, cycleId: settledCycle.cycleId });
    });
    database.raw.prepare(`
      UPDATE next_actions SET status = 'cancelled', completed_at = ?, settlement_json = '{}'
      WHERE id = 'pointer-settled-action'
    `).run(DOMAIN_TIMESTAMP);
    database.raw.exec('PRAGMA foreign_keys = ON');
    const results = repository.listOperationalCandidates();
    const kinds = results.map((result) => (
      result.kind === 'diagnostic' ? result.diagnostic.kind : 'candidate'
    ));
    expect(kinds.sort()).toEqual([
      'invalid_current_action', 'invalid_current_action',
    ]);
  });

  it('returns dated internal work for Unreviewed cycles', () => {
    const prospect = seedProspect(database.raw, 'unreviewed');
    let cycleId = '';
    withDeferredTransaction(() => {
      cycleId = insertCycleRow({ prefix: 'unreviewed', prospect, stage: 'unreviewed', pointer: null }).cycleId;
    });
    const results = repository.listOperationalCandidates();
    expect(results[0]).toMatchObject({ kind: 'candidate', candidate: { cycleId,
      action: { actionType: 'review_lead', dueAt: DOMAIN_TIMESTAMP, channel: null } } });
  });

  it('excludes closed and opted-out cycles from the candidate universe', () => {
    const closed = seedProspect(database.raw, 'closed');
    insertCycleRow({ prefix: 'closed', prospect: closed, workflowStatus: 'closed', stage: 'lost_nurture', pointer: null });
    expect(repository.listOperationalCandidates()).toHaveLength(0);
  });

  it('orders base rows only by binary cycle ID', () => {
    for (const prefix of ['zebra', 'alpha', 'middle']) {
      const prospect = seedProspect(database.raw, prefix);
      insertCycleWithAction({ prefix, prospect });
    }
    const results = repository.listOperationalCandidates();
    const ids = results.map((result) => (
      result.kind === 'candidate' ? result.candidate.cycleId : ''
    ));
    expect(ids).toEqual(['alpha-cycle', 'middle-cycle', 'zebra-cycle']);
  });

  it('flags a malformed cadence owner graph instead of dropping the row', () => {
    const prospect = seedProspect(database.raw, 'cadence-broken');
    let cycleId = '';
    database.raw.exec('PRAGMA foreign_keys = OFF');
    database.raw.exec('DROP TRIGGER protect_next_action_cadence_insert');
    withDeferredTransaction(() => {
      const inserted = insertCycleRow({ prefix: 'cadence-broken', prospect });
      cycleId = inserted.cycleId;
      // A cadence-bound action whose enrollment does not exist.
      database.raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, timezone,
          work_intent, cadence_enrollment_id, cadence_step_id, cadence_component_id,
          created_at
        ) VALUES (?, ?, 'call', 'phone', 'pending', 'America/New_York',
                  'discretionary_prospecting', 'missing-enrollment', 'missing-step',
                  'missing-component', ?)
      `).run(inserted.actionId, inserted.cycleId, DOMAIN_TIMESTAMP);
    });
    database.raw.exec('PRAGMA foreign_keys = ON');
    const results = repository.listOperationalCandidates();
    expect(results[0]).toMatchObject({
      kind: 'diagnostic',
      diagnostic: { cycleId, kind: 'cadence_owner_graph_mismatch' },
    });
  });

  it('admits only unamended owned callback evidence and retires it after a later logged call', () => {
    const prospect = seedProspect(database.raw, 'callback');
    const { cycleId } = insertCycleWithAction({ prefix: 'callback', prospect, workIntent: 'discretionary_prospecting' });
    const append = (id: string, callback: string | null, occurredAt = DOMAIN_TIMESTAMP) => database.raw.prepare(`
      INSERT INTO activities (id, person_id, prospect_id, sales_cycle_id, kind, direction, channel,
        occurred_at, observed_outcome, callback_at, created_at, metadata_json)
      VALUES (?, ?, ?, ?, 'call', 'outbound', 'phone', ?, 'spoke', ?, ?, '{}')`)
      .run(id, prospect.personId, prospect.prospectId, cycleId, occurredAt, callback, DOMAIN_TIMESTAMP);
    expect(repository.listOperationalCandidates()[0]).toMatchObject({ kind: 'candidate', candidate: { commitment: null } });
    append('promised-call', '2026-09-01T14:00:00.000Z');
    expect(repository.listOperationalCandidates()[0]).toMatchObject({ kind: 'candidate', candidate: {
      commitment: { kind: 'callback', activityId: 'promised-call', dueAt: '2026-09-01T14:00:00.000Z' } } });
    append('late-historical-call', null);
    expect(repository.listOperationalCandidates()[0]).toMatchObject({ kind: 'candidate', candidate: {
      commitment: { kind: 'callback', activityId: 'promised-call' } } });
    append('fulfilled-call', null, '2026-09-01T14:00:00.000Z');
    expect(repository.listOperationalCandidates()[0]).toMatchObject({ kind: 'candidate', candidate: { commitment: null } });
    append('older-rebook', '2026-09-05T14:00:00.000Z', '2026-09-01T15:00:00.000Z');
    append('newer-rebook', '2026-09-03T14:00:00.000Z', '2026-09-02T15:00:00.000Z');
    append('newer-fulfilled', null, '2026-09-03T15:00:00.000Z');
    expect(repository.listOperationalCandidates()[0]).toMatchObject({ kind: 'candidate', candidate: { commitment: null } });
    database.raw.prepare(`INSERT INTO activity_amendments
      (id, activity_id, amendment_kind, correction_json, reason, created_at)
      VALUES ('correct-rebooking', 'newer-rebook', 'correction', '{}', 'corrected callback', ?)`)
      .run(DOMAIN_TIMESTAMP);
    expect(repository.listOperationalCandidates()[0]).toMatchObject({ kind: 'candidate', candidate: { commitment: null } });
  });

  it('counts only valid same-day discretionary selected-call receipts once', () => {
    const prospect = seedProspect(database.raw, 'usage');
    const { cycleId, actionId } = insertCycleWithAction({ prefix: 'usage', prospect });
    const receipt = {
      version: 1,
      kind: 'discretionary_call',
      currentActionId: actionId,
      queueGeneratedAt: DOMAIN_TIMESTAMP,
      queueTimezone: 'America/New_York',
      queueLocalDate: '2026-08-30',
    };
    const insertCallActivity = (id: string, metadata: unknown, kind = 'call'): void => {
      database.raw.prepare(`
        INSERT INTO activities (
          id, person_id, prospect_id, sales_cycle_id, kind, direction, channel,
          occurred_at, observed_outcome, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, 'outbound', 'phone', ?, 'answered', ?, ?)
      `).run(
        id, prospect.personId, prospect.prospectId, cycleId, kind,
        DOMAIN_TIMESTAMP, JSON.stringify(metadata), DOMAIN_TIMESTAMP,
      );
    };
    insertCallActivity('usage-valid', { todaySelectedCallReceipt: receipt });
    // Wrong local date.
    insertCallActivity('usage-wrong-date', {
      todaySelectedCallReceipt: { ...receipt, queueLocalDate: '2026-08-29' },
    });
    // Non-call activity carrying the receipt.
    insertCallActivity('usage-non-call', { todaySelectedCallReceipt: receipt }, 'note');
    // Malformed receipt.
    insertCallActivity('usage-malformed', { todaySelectedCallReceipt: { version: 2 } });
    const usage = repository.loadCompletedDiscretionaryDialUsage({
      dayStartAt: DAY_START,
      dayEndAt: DAY_END,
      timezone: 'America/New_York',
      localDate: '2026-08-30',
    });
    expect(usage.count).toBe(1);
    expect(usage.activityIds).toEqual(['usage-valid']);
    expect(usage.diagnostics).toHaveLength(3);
    expect(usage.diagnostics.every(
      (entry) => entry.kind === 'invalid_selected_call_receipt',
    )).toBe(true);
  });

  it('rejects receipts naming promise/inbound/onboarding actions', () => {
    const prospect = seedProspect(database.raw, 'usage-promise');
    const { cycleId, actionId } = insertCycleWithAction({
      prefix: 'usage-promise', prospect, workIntent: 'promised_follow_up',
    });
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, prospect_id, sales_cycle_id, kind, direction, channel,
        occurred_at, observed_outcome, metadata_json, created_at
      ) VALUES ('usage-promise-activity', ?, ?, ?, 'call', 'outbound', 'phone',
                ?, 'answered', ?, ?)
    `).run(
      prospect.personId, prospect.prospectId, cycleId,
      DOMAIN_TIMESTAMP,
      JSON.stringify({
        todaySelectedCallReceipt: {
          version: 1,
          kind: 'discretionary_call',
          currentActionId: actionId,
          queueGeneratedAt: DOMAIN_TIMESTAMP,
          queueTimezone: 'America/New_York',
          queueLocalDate: '2026-08-30',
        },
      }),
      DOMAIN_TIMESTAMP,
    );
    const usage = repository.loadCompletedDiscretionaryDialUsage({
      dayStartAt: DAY_START,
      dayEndAt: DAY_END,
      timezone: 'America/New_York',
      localDate: '2026-08-30',
    });
    expect(usage.count).toBe(0);
    expect(usage.diagnostics).toHaveLength(1);
  });
});
