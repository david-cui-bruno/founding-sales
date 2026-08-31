import type { ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { resolveNativeBinding } from '../../src/main/db/sqliteDriver';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import { OptOutService } from '../../src/main/domain/optOut/optOutService';
import type { ApplyOptOutInput } from '../../src/main/domain/optOut/optOutTypes';
import { OutboundPermissionService } from '../../src/main/domain/optOut/outboundPermissionService';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  DOMAIN_TIMESTAMP,
  insertClosedCycle,
  insertOpenCycleWithAction,
  seedProspect,
} from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';
import {
  spawnBarrierSqlWorker,
  spawnOptOutCommandWorker,
  spawnReactivationCommandWorker,
} from '../support/domainWriteWorker';

describe('independent encrypted opt-out races', () => {
  let database: AppDatabase | undefined;
  let temp: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    temp?.cleanup();
  });

  async function setup() {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    let mainIds = 0;
    const ids = { next: () => `main-${++mainIds}` };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const lifecycle = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    const optOuts = new OptOutRepository({ database, unitOfWork });
    const service = new OptOutService({
      database, unitOfWork, identities, events,
      optOuts,
      lifecycle, clock, ids,
    });
    const permissions = new OutboundPermissionService({
      database, unitOfWork, identities, optOuts,
    });
    return { key, service, lifecycle, sources, unitOfWork, permissions, getMainIds: () => mainIds };
  }

  function command(
    personId: string,
    prefix: string,
    terminalStageEventId: string | null = null,
  ): ApplyOptOutInput {
    return {
      personId, tombstoneId: `${prefix}-tombstone`, requestedAt: DOMAIN_TIMESTAMP,
      policyVersion: 'founder_opt_out_v1',
      decision: { kind: 'structured_written', channel: 'imessage' },
      evidence: {
        kind: 'append_activity',
        activity: {
          id: `${prefix}-activity`, personId, kind: 'text', direction: 'inbound',
          channel: 'imessage', occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'opted_out',
          adapter: 'messages', providerIdempotencyKey: `${prefix}-provider`, metadata: {},
        },
      },
      terminalStageEventId,
    };
  }

  it('serializes two applications to one canonical tombstone without raw conflicts', async () => {
    const { key, getMainIds } = await setup();
    const prospect = seedProspect(database!.raw, 'two-opt-outs');
    database!.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES ('two-opt-outs-phone', ?, 'phone', '+14015550100', 'valid',
                'direct', 1, ?, ?)
    `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const readyPath = `${temp!.path}.opt-out-ready`;
    const startPath = `${readyPath}.start`;
    const attemptPath = `${readyPath}.attempt`;
    const lockedPath = `${readyPath}.locked`;
    const releasePath = `${readyPath}.release`;
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      startPath, attemptPath, lockedPath, releasePath,
      ids: ['worker-handle'], timestamp: DOMAIN_TIMESTAMP,
      command: command(prospect.personId, 'worker') as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    writeFileSync(startPath, 'start');
    await waitUntil(() => existsSync(lockedPath), 5_000);
    const loserReady = `${temp!.path}.opt-out-loser-ready`;
    const loserStart = `${loserReady}.start`;
    const loserAttempt = `${loserReady}.attempt`;
    const loserLocked = `${loserReady}.locked`;
    const loserRelease = `${loserReady}.release`;
    const loserWorker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath: loserReady,
      startPath: loserStart, attemptPath: loserAttempt,
      lockedPath: loserLocked, releasePath: loserRelease,
      ids: [], timestamp: DOMAIN_TIMESTAMP,
      command: command(prospect.personId, 'main') as unknown as Readonly<Record<string, unknown>>,
    });
    const loserExit = captureExit(loserWorker);
    await waitUntil(() => existsSync(loserReady), 5_000);
    writeFileSync(loserStart, 'start');
    await waitUntil(() => existsSync(loserAttempt), 5_000);
    writeFileSync(releasePath, 'release');
    expect(await exit).toMatchObject({ code: 0, stderr: '' });
    await waitUntil(() => existsSync(loserLocked), 5_000);
    writeFileSync(loserRelease, 'release');
    const loser = await loserExit;
    expect(loser).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(loser.stdout)).toMatchObject({
      alreadyApplied: true, tombstone: { id: 'worker-tombstone' },
    });
    expect(getMainIds()).toBe(0);
    expect(database!.raw.prepare(`SELECT COUNT(*) AS count FROM opt_out_tombstones`).get())
      .toEqual({ count: 1 });
    expect(database!.raw.prepare(`SELECT COUNT(*) AS count FROM activities WHERE person_id = ?`)
      .get(prospect.personId)).toEqual({ count: 2 });
    expect(database!.raw.prepare(`SELECT COUNT(*) AS count FROM opt_out_handles`).get())
      .toEqual({ count: 1 });
  }, 10_000);

  it('makes a stale open-cycle insertion lose after opt-out linearizes', async () => {
    const { key } = await setup();
    const prospect = seedProspect(database!.raw, 'opt-out-cycle-race');
    const readyPath = `${temp!.path}.opt-out-cycle-ready`;
    const startPath = `${readyPath}.start`;
    const attemptPath = `${readyPath}.attempt`;
    const lockedPath = `${readyPath}.locked`;
    const releasePath = `${readyPath}.release`;
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      startPath, attemptPath, lockedPath, releasePath,
      ids: [], timestamp: DOMAIN_TIMESTAMP,
      command: command(prospect.personId, 'cycle-winner') as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    writeFileSync(startPath, 'start');
    await waitUntil(() => existsSync(lockedPath), 5_000);
    const contenderReady = `${readyPath}.cycle-ready`;
    const contenderStart = `${contenderReady}.start`;
    const contenderAttempt = `${contenderReady}.attempt`;
    const contenderLocked = `${contenderReady}.locked`;
    const contenderRelease = `${contenderReady}.release`;
    const contender = spawnBarrierSqlWorker({
      databasePath: temp!.path, nativeBinding: resolveNativeBinding(),
      keyHex: key.bytes.toString('hex'), readyPath: contenderReady,
      startPath: contenderStart, attemptPath: contenderAttempt,
      lockedPath: contenderLocked, releasePath: contenderRelease,
      statements: [
        {
          sql: `INSERT INTO sales_cycles (
            id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
            current_next_action_id, stage_entered_at, version, created_at, updated_at
          ) VALUES ('stale-cycle', ?, ?, ?, 'unreviewed', 'active',
            'stale-cycle-action', ?, 1, ?, ?)`,
          params: [
            prospect.personId, prospect.prospectId, prospect.sourceEventId,
            DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
          ],
        },
        {
          sql: `INSERT INTO next_actions (
            id, sales_cycle_id, action_type, channel, status, due_at, timezone,
            work_intent, version, created_at, updated_at
          ) VALUES ('stale-cycle-action', 'stale-cycle', 'review_lead', NULL,
            'pending', ?, 'America/New_York', 'internal_review', 1, ?, ?)`,
          params: [DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP],
        },
        {
          sql: `INSERT INTO stage_events (
            id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
            confirmation_kind, transition_sequence, created_at
          ) VALUES ('stale-cycle-event', 'stale-cycle', NULL, 'unreviewed', ?, ?,
            'mechanical', 1, ?)`,
          params: [DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP],
        },
      ],
    });
    const contenderExit = captureExit(contender);
    await waitUntil(() => existsSync(contenderReady), 5_000);
    writeFileSync(contenderStart, 'start');
    await waitUntil(() => existsSync(contenderAttempt), 5_000);
    writeFileSync(releasePath, 'release');
    expect(await exit).toMatchObject({ code: 0, stderr: '' });
    await waitUntil(() => existsSync(contenderLocked), 5_000);
    writeFileSync(contenderRelease, 'release');
    expect(await contenderExit).toMatchObject({ code: 1 });
    expect(database!.raw.prepare(`
      SELECT COUNT(*) AS count FROM sales_cycles
      WHERE person_id = ? AND workflow_status IN ('active','onboarding')
    `).get(prospect.personId)).toEqual({ count: 0 });
    expect(database!.raw.prepare(`SELECT opted_out FROM persons WHERE id = ?`)
      .get(prospect.personId)).toEqual({ opted_out: 1 });
  }, 10_000);

  it('re-reads and closes workflow that linearizes before opt-out', async () => {
    const { key } = await setup();
    const prospect = seedProspect(database!.raw, 'cycle-first-race');
    database!.raw.exec('BEGIN IMMEDIATE');
    database!.raw.prepare(`
      INSERT INTO sales_cycles (
        id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
        current_next_action_id, stage_entered_at, version, created_at, updated_at
      ) VALUES ('cycle-first', ?, ?, ?, 'unreviewed', 'active', 'cycle-first-action',
                ?, 1, ?, ?)
    `).run(
      prospect.personId, prospect.prospectId, prospect.sourceEventId,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
    );
    database!.raw.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status, due_at, timezone,
        work_intent, version, created_at, updated_at
      ) VALUES ('cycle-first-action', 'cycle-first', 'review_lead', NULL, 'pending', ?,
                'America/New_York', 'internal_review', 1, ?, ?)
    `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const readyPath = `${temp!.path}.cycle-first-ready`;
    const startPath = `${readyPath}.start`;
    const attemptPath = `${readyPath}.attempt`;
    const lockedPath = `${readyPath}.locked`;
    const releasePath = `${readyPath}.release`;
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      startPath, attemptPath, lockedPath, releasePath,
      ids: [], timestamp: DOMAIN_TIMESTAMP,
      command: command(
        prospect.personId, 'cycle-first-winner', 'cycle-first-terminal',
      ) as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    writeFileSync(startPath, 'start');
    await waitUntil(() => existsSync(attemptPath), 5_000);
    database!.raw.exec('COMMIT');
    await waitUntil(() => existsSync(lockedPath), 5_000);
    writeFileSync(releasePath, 'release');

    expect(await exit).toMatchObject({ code: 0, stderr: '' });
    expect(database!.raw.prepare(`
      SELECT stage, workflow_status, current_next_action_id, close_reason
      FROM sales_cycles WHERE id = 'cycle-first'
    `).get()).toEqual({
      stage: 'lost_nurture', workflow_status: 'closed',
      current_next_action_id: null, close_reason: 'opt_out',
    });
    expect(database!.raw.prepare(`
      SELECT status FROM next_actions WHERE id = 'cycle-first-action'
    `).get()).toEqual({ status: 'cancelled' });
    expect(database!.raw.prepare(`
      SELECT id FROM opt_out_tombstones WHERE person_id = ?
    `).get(prospect.personId)).toEqual({ id: 'cycle-first-winner-tombstone' });
  }, 10_000);

  it('closes the exact replacement current action that linearizes before opt-out', async () => {
    const { key } = await setup();
    const prospect = seedProspect(database!.raw, 'replacement-first-race');
    const cycle = insertOpenCycleWithAction({
      database: database!.raw, prefix: 'replacement-first-race', prospect,
    });
    const readyPath = `${temp!.path}.replacement-first-ready`;
    const startPath = `${readyPath}.start`;
    const attemptPath = `${readyPath}.attempt`;
    const lockedPath = `${readyPath}.locked`;
    const releasePath = `${readyPath}.release`;
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      startPath, attemptPath, lockedPath, releasePath, ids: [], timestamp: DOMAIN_TIMESTAMP,
      command: command(
        prospect.personId, 'replacement-first-opt-out', 'replacement-first-terminal',
      ) as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    database!.raw.exec('BEGIN IMMEDIATE');
    database!.raw.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status, due_at, timezone,
        work_intent, created_at, updated_at
      ) VALUES ('replacement-action', ?, 'review_replacement', NULL, 'pending', ?,
        'America/New_York', 'internal_review', ?, ?)
    `).run(cycle.cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database!.raw.prepare(`
      UPDATE sales_cycles SET current_next_action_id = 'replacement-action',
        version = version + 1, updated_at = ? WHERE id = ?
    `).run(DOMAIN_TIMESTAMP, cycle.cycleId);
    const settlement = JSON.stringify({
      version: 1, outcome: 'phase_completed', reason: null, evidenceActivityId: null,
      plannerTransition: {
        definitionId: null, stepId: null, componentId: null,
        attempt: null, outcome: 'phase_completed',
      },
      cadence: {
        cadenceEnrollmentId: null, cadenceDefinitionId: null,
        cadenceStepId: null, cadenceComponentId: null,
      },
      workIntent: 'internal_review',
      inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
    });
    database!.raw.prepare(`
      UPDATE next_actions SET status = 'completed', settlement_json = ?,
        completed_at = ?, version = version + 1, updated_at = ? WHERE id = ?
    `).run(settlement, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, cycle.actionId);
    writeFileSync(startPath, 'start');
    await waitUntil(() => existsSync(attemptPath), 5_000);
    database!.raw.exec('COMMIT');
    await waitUntil(() => existsSync(lockedPath), 5_000);
    writeFileSync(releasePath, 'release');

    expect(await exit).toMatchObject({ code: 0, stderr: '' });
    expect(database!.raw.prepare(`
      SELECT current_next_action_id, workflow_status, close_reason
      FROM sales_cycles WHERE id = ?
    `).get(cycle.cycleId)).toEqual({
      current_next_action_id: null, workflow_status: 'closed', close_reason: 'opt_out',
    });
    expect(database!.raw.prepare(`
      SELECT status FROM next_actions WHERE id = 'replacement-action'
    `).get()).toEqual({ status: 'cancelled' });
  }, 10_000);

  it('makes a concurrent reactivation observe the permanent tombstone', async () => {
    const { key } = await setup();
    const prospect = seedProspect(database!.raw, 'opt-out-reactivation-race');
    const readyPath = `${temp!.path}.opt-out-reactivation-ready`;
    const startPath = `${readyPath}.start`;
    const attemptPath = `${readyPath}.attempt`;
    const lockedPath = `${readyPath}.locked`;
    const releasePath = `${readyPath}.release`;
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      startPath, attemptPath, lockedPath, releasePath,
      ids: [], timestamp: DOMAIN_TIMESTAMP,
      command: command(prospect.personId, 'reactivation-winner') as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    writeFileSync(startPath, 'start');
    await waitUntil(() => existsSync(lockedPath), 5_000);
    const warm = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
    const reactivationReady = `${readyPath}.reactivation-ready`;
    const reactivationStart = `${reactivationReady}.start`;
    const reactivationAttempt = `${reactivationReady}.attempt`;
    const reactivationLocked = `${reactivationReady}.locked`;
    const reactivationRelease = `${reactivationReady}.release`;
    const reactivation = spawnReactivationCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'),
      readyPath: reactivationReady, startPath: reactivationStart,
      attemptPath: reactivationAttempt, lockedPath: reactivationLocked,
      releasePath: reactivationRelease, holdLockBeforeCommand: false,
      ids: [], timestamp: DOMAIN_TIMESTAMP,
      command: {
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId: 'historical-cycle', newCycleId: 'forbidden-cycle',
      activatedAt: DOMAIN_TIMESTAMP,
      cadence: {
        definitionId: warm.id, family: 'cadence_c', version: warm.version,
        contentHash: warm.contentHash,
      },
      evidence: {
        kind: 'unknown_handle', handleKind: 'phone', normalizedValue: '+14015550999',
      },
      },
    });
    const reactivationExit = captureExit(reactivation);
    await waitUntil(() => existsSync(reactivationReady), 5_000);
    writeFileSync(reactivationStart, 'start');
    await waitUntil(() => existsSync(reactivationAttempt), 5_000);
    writeFileSync(releasePath, 'release');
    expect(await exit).toMatchObject({ code: 0, stderr: '' });
    const reactivationResult = await reactivationExit;
    expect(reactivationResult).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(reactivationResult.stdout)).toEqual({
      kind: 'permanently_blocked', tombstoneId: 'reactivation-winner-tombstone',
    });
    expect(database!.raw.prepare(`SELECT COUNT(*) AS count FROM lifecycle_review_items`).get())
      .toEqual({ count: 0 });
    expect(database!.raw.prepare(`SELECT COUNT(*) AS count FROM sales_cycles`).get())
      .toEqual({ count: 0 });
  }, 10_000);

  it('closes a reactivation that commits before opt-out starts', async () => {
    const { key, sources, unitOfWork } = await setup();
    const prospect = seedProspect(database!.raw, 'reactivation-first-race');
    const sourceCycleId = insertClosedCycle({
      database: database!.raw, prefix: 'reactivation-first-source', prospect,
    });
    unitOfWork.immediate(() => sources.append({
      id: 'reactivation-first-inbound', personId: prospect.personId,
      prospectId: prospect.prospectId, channel: 'inbound_demo',
      observedAt: DOMAIN_TIMESTAMP, sourceRecord: { message: 'DEMO' },
    }));
    const readyPath = `${temp!.path}.reactivation-first-ready`;
    const startPath = `${readyPath}.start`;
    const attemptPath = `${readyPath}.attempt`;
    const lockedPath = `${readyPath}.locked`;
    const releasePath = `${readyPath}.release`;
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      startPath, attemptPath, lockedPath, releasePath, ids: [], timestamp: DOMAIN_TIMESTAMP,
      command: command(
        prospect.personId, 'reactivation-first-opt-out', 'reactivation-first-terminal',
      ) as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    const warm = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
    const reactivationReady = `${readyPath}.reactivation-ready`;
    const reactivationStart = `${reactivationReady}.start`;
    const reactivationAttempt = `${reactivationReady}.attempt`;
    const reactivationLocked = `${reactivationReady}.locked`;
    const reactivationRelease = `${reactivationReady}.release`;
    const reactivation = spawnReactivationCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'),
      readyPath: reactivationReady, startPath: reactivationStart,
      attemptPath: reactivationAttempt, lockedPath: reactivationLocked,
      releasePath: reactivationRelease, holdLockBeforeCommand: true,
      ids: ['reactivation-first-enrollment', 'reactivation-first-action', 'reactivation-first-event'],
      timestamp: DOMAIN_TIMESTAMP,
      command: {
        personId: prospect.personId, prospectId: prospect.prospectId,
        sourceCycleId, newCycleId: 'reactivation-first-cycle', activatedAt: DOMAIN_TIMESTAMP,
        cadence: {
          definitionId: warm.id, family: 'cadence_c', version: warm.version,
          contentHash: warm.contentHash,
        },
        evidence: {
          kind: 'source_event', sourceEventId: 'reactivation-first-inbound',
          channel: 'inbound_demo',
        },
      },
    });
    const reactivationExit = captureExit(reactivation);
    await waitUntil(() => existsSync(reactivationReady), 5_000);
    writeFileSync(reactivationStart, 'start');
    await waitUntil(() => existsSync(reactivationLocked), 5_000);
    writeFileSync(startPath, 'start');
    await waitUntil(() => existsSync(attemptPath), 5_000);
    writeFileSync(reactivationRelease, 'release');
    expect(await reactivationExit).toMatchObject({ code: 0, stderr: '' });
    await waitUntil(() => existsSync(lockedPath), 5_000);
    writeFileSync(releasePath, 'release');

    expect(await exit).toMatchObject({ code: 0, stderr: '' });
    expect(database!.raw.prepare(`
      SELECT workflow_status, close_reason FROM sales_cycles
      WHERE id = 'reactivation-first-cycle'
    `).get()).toEqual({ workflow_status: 'closed', close_reason: 'opt_out' });
    expect(database!.raw.prepare(`
      SELECT COUNT(*) AS count FROM sales_cycles
      WHERE person_id = ? AND workflow_status IN ('active','onboarding')
    `).get(prospect.personId)).toEqual({ count: 0 });
  }, 10_000);

  it('serializes contact capture on both sides of permanent opt-out', async () => {
    const { key } = await setup();
    const contactFirst = seedProspect(database!.raw, 'contact-first-race');
    const firstReady = `${temp!.path}.contact-first-ready`;
    const firstStart = `${firstReady}.start`;
    const firstAttempt = `${firstReady}.attempt`;
    const firstLocked = `${firstReady}.locked`;
    const firstRelease = `${firstReady}.release`;
    const firstWorker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath: firstReady,
      startPath: firstStart, attemptPath: firstAttempt,
      lockedPath: firstLocked, releasePath: firstRelease,
      ids: ['contact-first-handle'], timestamp: DOMAIN_TIMESTAMP,
      command: command(contactFirst.personId, 'contact-first-opt-out') as unknown as Readonly<Record<string, unknown>>,
    });
    const firstExit = captureExit(firstWorker);
    await waitUntil(() => existsSync(firstReady), 5_000);
    database!.raw.exec('BEGIN IMMEDIATE');
    insertPhoneContact(database!, 'contact-first-phone', contactFirst.personId, '+14015550110');
    writeFileSync(firstStart, 'start');
    await waitUntil(() => existsSync(firstAttempt), 5_000);
    database!.raw.exec('COMMIT');
    await waitUntil(() => existsSync(firstLocked), 5_000);
    writeFileSync(firstRelease, 'release');
    expect(await firstExit).toMatchObject({ code: 0, stderr: '' });
    expect(database!.raw.prepare(`
      SELECT normalized_value FROM opt_out_handles
      WHERE tombstone_id = 'contact-first-opt-out-tombstone'
    `).all()).toEqual([{ normalized_value: '+14015550110' }]);

    const optOutFirst = seedProspect(database!.raw, 'opt-out-first-contact-race');
    const secondReady = `${temp!.path}.opt-out-first-contact-ready`;
    const secondStart = `${secondReady}.start`;
    const secondAttempt = `${secondReady}.attempt`;
    const secondLocked = `${secondReady}.locked`;
    const secondRelease = `${secondReady}.release`;
    const secondWorker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath: secondReady,
      startPath: secondStart, attemptPath: secondAttempt,
      lockedPath: secondLocked, releasePath: secondRelease,
      ids: [], timestamp: DOMAIN_TIMESTAMP,
      command: command(optOutFirst.personId, 'opt-out-first-contact') as unknown as Readonly<Record<string, unknown>>,
    });
    const secondExit = captureExit(secondWorker);
    await waitUntil(() => existsSync(secondReady), 5_000);
    writeFileSync(secondStart, 'start');
    await waitUntil(() => existsSync(secondLocked), 5_000);
    const contactReady = `${secondReady}.contact-ready`;
    const contactStart = `${contactReady}.start`;
    const contactAttempt = `${contactReady}.attempt`;
    const contactLocked = `${contactReady}.locked`;
    const contactRelease = `${contactReady}.release`;
    const contact = spawnBarrierSqlWorker({
      databasePath: temp!.path, nativeBinding: resolveNativeBinding(),
      keyHex: key.bytes.toString('hex'), readyPath: contactReady,
      startPath: contactStart, attemptPath: contactAttempt,
      lockedPath: contactLocked, releasePath: contactRelease,
      statements: [{
        sql: `INSERT INTO person_contact_methods (
          id, person_id, kind, normalized_value, validation_state, reachability,
          is_primary, created_at, updated_at
        ) VALUES ('opt-out-first-late-phone', ?, 'phone', '+14015550111',
          'valid', 'direct', 1, ?, ?)`,
        params: [optOutFirst.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP],
      }],
    });
    const contactExit = captureExit(contact);
    await waitUntil(() => existsSync(contactReady), 5_000);
    writeFileSync(contactStart, 'start');
    await waitUntil(() => existsSync(contactAttempt), 5_000);
    writeFileSync(secondRelease, 'release');
    expect(await secondExit).toMatchObject({ code: 0, stderr: '' });
    await waitUntil(() => existsSync(contactLocked), 5_000);
    writeFileSync(contactRelease, 'release');
    expect(await contactExit).toMatchObject({ code: 1 });
  }, 10_000);

  it('retains the same normalized handle under two independently opted-out Persons', async () => {
    const { key } = await setup();
    const first = seedProspect(database!.raw, 'shared-handle-first');
    const second = seedProspect(database!.raw, 'shared-handle-second');
    for (const [id, personId] of [
      ['shared-first-contact', first.personId],
      ['shared-second-contact', second.personId],
    ] as const) {
      database!.raw.prepare(`
        INSERT INTO person_contact_methods (
          id, person_id, kind, normalized_value, validation_state, reachability,
          is_primary, created_at, updated_at
        ) VALUES (?, ?, 'phone', '+14015550100', 'valid', 'direct', 1, ?, ?)
      `).run(id, personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    }
    const readyPath = `${temp!.path}.shared-handle-ready`;
    const startPath = `${readyPath}.start`;
    const attemptPath = `${readyPath}.attempt`;
    const lockedPath = `${readyPath}.locked`;
    const releasePath = `${readyPath}.release`;
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      startPath, attemptPath, lockedPath, releasePath,
      ids: ['shared-worker-handle'], timestamp: DOMAIN_TIMESTAMP,
      command: command(first.personId, 'shared-worker') as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    writeFileSync(startPath, 'start');
    await waitUntil(() => existsSync(lockedPath), 5_000);
    const secondReady = `${temp!.path}.shared-handle-second-ready`;
    const secondStart = `${secondReady}.start`;
    const secondAttempt = `${secondReady}.attempt`;
    const secondLocked = `${secondReady}.locked`;
    const secondRelease = `${secondReady}.release`;
    const secondWorker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath: secondReady,
      startPath: secondStart, attemptPath: secondAttempt,
      lockedPath: secondLocked, releasePath: secondRelease,
      ids: ['shared-second-handle'], timestamp: DOMAIN_TIMESTAMP,
      command: command(second.personId, 'shared-main') as unknown as Readonly<Record<string, unknown>>,
    });
    const secondExit = captureExit(secondWorker);
    await waitUntil(() => existsSync(secondReady), 5_000);
    writeFileSync(secondStart, 'start');
    await waitUntil(() => existsSync(secondAttempt), 5_000);
    writeFileSync(releasePath, 'release');
    expect(await exit).toMatchObject({ code: 0, stderr: '' });
    await waitUntil(() => existsSync(secondLocked), 5_000);
    writeFileSync(secondRelease, 'release');
    const secondResult = await secondExit;
    expect(secondResult).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(secondResult.stdout)).toMatchObject({
      alreadyApplied: false, tombstone: { id: 'shared-main-tombstone' },
    });
    expect(database!.raw.prepare(`
      SELECT tombstone.id
      FROM opt_out_handles AS handle
      JOIN opt_out_tombstones AS tombstone ON tombstone.id = handle.tombstone_id
      WHERE handle.kind = 'phone' AND handle.normalized_value = '+14015550100'
      ORDER BY tombstone.id
    `).all()).toEqual([
      { id: 'shared-main-tombstone' }, { id: 'shared-worker-tombstone' },
    ]);
  }, 10_000);

  it('serializes fresh-Person same-handle re-import on both sides of opt-out', async () => {
    const { key, permissions } = await setup();
    const firstOwner = seedProspect(database!.raw, 'reimport-first-owner');
    const firstFresh = seedProspect(database!.raw, 'reimport-first-fresh');
    insertPhoneContact(database!, 'reimport-first-owner-phone', firstOwner.personId, '+14015550120');
    const firstReady = `${temp!.path}.reimport-first-ready`;
    const firstStart = `${firstReady}.start`;
    const firstAttempt = `${firstReady}.attempt`;
    const firstLocked = `${firstReady}.locked`;
    const firstRelease = `${firstReady}.release`;
    const firstOptOut = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath: firstReady,
      startPath: firstStart, attemptPath: firstAttempt,
      lockedPath: firstLocked, releasePath: firstRelease,
      ids: ['reimport-first-handle'], timestamp: DOMAIN_TIMESTAMP,
      command: command(firstOwner.personId, 'reimport-first-opt-out') as unknown as Readonly<Record<string, unknown>>,
    });
    const firstExit = captureExit(firstOptOut);
    await waitUntil(() => existsSync(firstReady), 5_000);
    database!.raw.exec('BEGIN IMMEDIATE');
    insertPhoneContact(database!, 'reimport-first-fresh-phone', firstFresh.personId, '+14015550120');
    writeFileSync(firstStart, 'start');
    await waitUntil(() => existsSync(firstAttempt), 5_000);
    database!.raw.exec('COMMIT');
    await waitUntil(() => existsSync(firstLocked), 5_000);
    writeFileSync(firstRelease, 'release');
    expect(await firstExit).toMatchObject({ code: 0, stderr: '' });
    expect(database!.raw.prepare(`
      SELECT COUNT(*) AS count FROM person_contact_methods
      WHERE person_id = ? AND normalized_value = '+14015550120'
    `).get(firstFresh.personId)).toEqual({ count: 1 });
    expect(database!.raw.prepare(`
      SELECT COUNT(*) AS count FROM opt_out_handles
      WHERE normalized_value = '+14015550120'
    `).get()).toEqual({ count: 1 });
    expect(permissions.inspectPerson(firstFresh.personId)).toMatchObject({ kind: 'blocked' });

    const secondOwner = seedProspect(database!.raw, 'opt-out-first-reimport-owner');
    const secondFresh = seedProspect(database!.raw, 'opt-out-first-reimport-fresh');
    insertPhoneContact(database!, 'opt-out-first-owner-phone', secondOwner.personId, '+14015550121');
    const secondReady = `${temp!.path}.opt-out-first-reimport-ready`;
    const secondStart = `${secondReady}.start`;
    const secondAttempt = `${secondReady}.attempt`;
    const secondLocked = `${secondReady}.locked`;
    const secondRelease = `${secondReady}.release`;
    const secondOptOut = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath: secondReady,
      startPath: secondStart, attemptPath: secondAttempt,
      lockedPath: secondLocked, releasePath: secondRelease,
      ids: ['opt-out-first-reimport-handle'], timestamp: DOMAIN_TIMESTAMP,
      command: command(secondOwner.personId, 'opt-out-first-reimport') as unknown as Readonly<Record<string, unknown>>,
    });
    const secondExit = captureExit(secondOptOut);
    await waitUntil(() => existsSync(secondReady), 5_000);
    writeFileSync(secondStart, 'start');
    await waitUntil(() => existsSync(secondLocked), 5_000);
    const reimportReady = `${secondReady}.reimport-ready`;
    const reimportStart = `${reimportReady}.start`;
    const reimportAttempt = `${reimportReady}.attempt`;
    const reimportLocked = `${reimportReady}.locked`;
    const reimportRelease = `${reimportReady}.release`;
    const reimport = spawnBarrierSqlWorker({
      databasePath: temp!.path, nativeBinding: resolveNativeBinding(),
      keyHex: key.bytes.toString('hex'), readyPath: reimportReady,
      startPath: reimportStart, attemptPath: reimportAttempt,
      lockedPath: reimportLocked, releasePath: reimportRelease,
      statements: [{
        sql: `INSERT INTO person_contact_methods (
          id, person_id, kind, normalized_value, validation_state, reachability,
          is_primary, created_at, updated_at
        ) VALUES ('opt-out-first-fresh-phone', ?, 'phone', '+14015550121',
          'valid', 'direct', 1, ?, ?)`,
        params: [secondFresh.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP],
      }],
    });
    const reimportExit = captureExit(reimport);
    await waitUntil(() => existsSync(reimportReady), 5_000);
    writeFileSync(reimportStart, 'start');
    await waitUntil(() => existsSync(reimportAttempt), 5_000);
    writeFileSync(secondRelease, 'release');
    expect(await secondExit).toMatchObject({ code: 0, stderr: '' });
    await waitUntil(() => existsSync(reimportLocked), 5_000);
    writeFileSync(reimportRelease, 'release');
    expect(await reimportExit).toMatchObject({ code: 0, stderr: '' });
    expect(database!.raw.prepare(`
      SELECT COUNT(*) AS count FROM person_contact_methods WHERE person_id = ?
    `).get(secondFresh.personId)).toEqual({ count: 1 });
    expect(permissions.inspectPerson(secondFresh.personId)).toMatchObject({ kind: 'blocked' });
  }, 15_000);
});

function captureExit(worker: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    worker.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    worker.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    worker.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for race barrier.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function insertPhoneContact(
  database: AppDatabase,
  id: string,
  personId: string,
  normalizedValue: string,
): void {
  database.raw.prepare(`
    INSERT INTO person_contact_methods (
      id, person_id, kind, normalized_value, validation_state, reachability,
      is_primary, created_at, updated_at
    ) VALUES (?, ?, 'phone', ?, 'valid', 'direct', 1, ?, ?)
  `).run(id, personId, normalizedValue, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
}
