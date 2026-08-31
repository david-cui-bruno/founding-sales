import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import { OptOutService } from '../../src/main/domain/optOut/optOutService';
import type { ApplyOptOutInput } from '../../src/main/domain/optOut/optOutTypes';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  DOMAIN_TIMESTAMP,
  insertOpenCycleWithAction,
  seedProspect,
} from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';
import { spawnOptOutCommandWorker } from '../support/domainWriteWorker';

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
    const service = new OptOutService({
      database, unitOfWork, identities, events,
      optOuts: new OptOutRepository({ database, unitOfWork }),
      lifecycle, clock, ids,
    });
    return { key, service, lifecycle, getMainIds: () => mainIds };
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
    const { key, service, getMainIds } = await setup();
    const prospect = seedProspect(database!.raw, 'two-opt-outs');
    database!.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES ('two-opt-outs-phone', ?, 'phone', '+14015550100', 'valid',
                'direct', 1, ?, ?)
    `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const readyPath = `${temp!.path}.opt-out-ready`;
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      ids: ['worker-handle'], timestamp: DOMAIN_TIMESTAMP,
      command: command(prospect.personId, 'worker') as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);

    const loser = service.apply(command(prospect.personId, 'main'));
    expect(loser).toMatchObject({
      alreadyApplied: true, tombstone: { id: 'worker-tombstone' },
    });
    expect(await exit).toMatchObject({ code: 0, stderr: '' });
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
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      ids: [], timestamp: DOMAIN_TIMESTAMP,
      command: command(prospect.personId, 'cycle-winner') as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);

    expect(() => insertOpenCycleWithAction({
      database: database!.raw, prefix: 'stale-cycle', prospect,
    })).toThrow();
    expect(await exit).toMatchObject({ code: 0, stderr: '' });
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
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      ids: [], timestamp: DOMAIN_TIMESTAMP,
      command: command(
        prospect.personId, 'cycle-first-winner', 'cycle-first-terminal',
      ) as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await new Promise((resolve) => setTimeout(resolve, 100));
    database!.raw.exec('COMMIT');

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

  it('makes a concurrent reactivation observe the permanent tombstone', async () => {
    const { key, lifecycle } = await setup();
    const prospect = seedProspect(database!.raw, 'opt-out-reactivation-race');
    const readyPath = `${temp!.path}.opt-out-reactivation-ready`;
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      ids: [], timestamp: DOMAIN_TIMESTAMP,
      command: command(prospect.personId, 'reactivation-winner') as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);
    const warm = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;

    expect(lifecycle.reactivateFromInboundResponse({
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
    })).toEqual({
      kind: 'permanently_blocked', tombstoneId: 'reactivation-winner-tombstone',
    });
    expect(await exit).toMatchObject({ code: 0, stderr: '' });
    expect(database!.raw.prepare(`SELECT COUNT(*) AS count FROM lifecycle_review_items`).get())
      .toEqual({ count: 0 });
    expect(database!.raw.prepare(`SELECT COUNT(*) AS count FROM sales_cycles`).get())
      .toEqual({ count: 0 });
  }, 10_000);

  it('retains the same normalized handle under two independently opted-out Persons', async () => {
    const { key, service } = await setup();
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
    const worker = spawnOptOutCommandWorker({
      databasePath: temp!.path, keyHex: key.bytes.toString('hex'), readyPath,
      ids: ['shared-worker-handle'], timestamp: DOMAIN_TIMESTAMP,
      command: command(first.personId, 'shared-worker') as unknown as Readonly<Record<string, unknown>>,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);

    expect(service.apply(command(second.personId, 'shared-main'))).toMatchObject({
      alreadyApplied: false, tombstone: { id: 'shared-main-tombstone' },
    });
    expect(await exit).toMatchObject({ code: 0, stderr: '' });
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
