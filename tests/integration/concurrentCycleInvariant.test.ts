import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { resolveNativeBinding } from '../../src/main/db/sqliteDriver';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { OperationalCycleExistsError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { spawnDomainWriteWorker } from '../support/domainWriteWorker';

describe('concurrent SalesCycle invariant', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  it('serializes independent encrypted connections so one Person gets one open cycle', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const prospect = seedProspect(database.raw, 'race');
    database.raw.prepare(`UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?`)
      .run(prospect.prospectId);
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const ids = { next: () => 'must-not-be-consumed' };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    const readyPath = `${workspace.path}.cycle-ready`;
    const worker = spawnDomainWriteWorker({
      databasePath: workspace.path, nativeBinding: resolveNativeBinding(),
      keyHex: key.bytes.toString('hex'), readyPath,
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceEventId: prospect.sourceEventId, cycleId: 'worker-cycle',
      actionId: 'worker-action', eventId: 'worker-event', timestamp: DOMAIN_TIMESTAMP,
    });
    const exit = captureExit(worker);
    await waitUntil(() => existsSync(readyPath), 5_000);

    expect(() => service.createUnreviewedCycle({
      personId: prospect.personId, prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
    })).toThrow(OperationalCycleExistsError);
    expect(await exit).toEqual({ code: 0, stderr: '' });
    expect(database.raw.prepare(`
      SELECT id, current_next_action_id FROM sales_cycles
      WHERE person_id = ? AND workflow_status IN ('active','onboarding')
    `).all(prospect.personId)).toEqual([
      { id: 'worker-cycle', current_next_action_id: 'worker-action' },
    ]);
  }, 10_000);
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for lifecycle contender.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function captureExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}
