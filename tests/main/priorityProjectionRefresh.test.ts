import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import {
  PRIORITY_PROJECTION_REBUILD_JOB_TYPE,
} from '../../src/main/domain/startup/domainStartupTypes';
import {
  deriveRefreshIdempotencyKey,
  fingerprintCanonical,
} from '../../src/main/domain/startup/priorityProjectionRefresh';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  PrioritizationRepository,
} from '../../src/main/domain/prioritization/prioritizationRepository';
import {
  PrioritizationService,
} from '../../src/main/domain/prioritization/prioritizationService';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import {
  OutboundPermissionService,
} from '../../src/main/domain/optOut/outboundPermissionService';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect, type SeededProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const BOOT_AT = '2026-08-30T12:00:00.000Z';

describe('priority projection refresh at startup', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let phoneCounter = 5000;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  let runtimeCounter = 0;

  function buildRuntime() {
    runtimeCounter += 1;
    const prefix = `refresh-id-${runtimeCounter}`;
    let idCounter = 0;
    const clock = { now: () => BOOT_AT };
    const ids = { next: () => `${prefix}-${++idCounter}` };
    return new DomainRuntime({ database, clock, ids });
  }

  function buildPrioritizationStack() {
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => BOOT_AT };
    const ids = {
      next: (): string => {
        throw new Error('unused');
      },
    };
    const repository = new PrioritizationRepository({ database, unitOfWork, clock });
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const optOuts = new OptOutRepository({ database, unitOfWork });
    const outboundPermission = new OutboundPermissionService({
      database, unitOfWork, identities, optOuts,
    });
    const priorities = new PrioritizationService({
      database, unitOfWork, clock, repository, outboundPermission,
    });
    return { unitOfWork, repository, priorities };
  }

  function addDirectPhone(prospect: SeededProspect, id: string): void {
    phoneCounter += 1;
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES (?, ?, 'phone', ?, 'valid', 'direct', 1, ?, ?)
    `).run(id, prospect.personId, `+1401555${phoneCounter}`,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  it('queues a missing-projection rebuild job for an eligible prospect', () => {
    seedProspect(database.raw, 'refresh-missing');
    const report = buildRuntime().initialize();
    expect(report.projectionRefreshCandidateCount).toBe(1);
    expect(report.projectionRebuildsQueued).toBe(1);
    expect(report.pendingProjectionRebuilds).toBe(1);
    const job = database.raw.prepare(`
      SELECT type, state, idempotency_key, payload_json FROM jobs
      WHERE type = ?
    `).get(PRIORITY_PROJECTION_REBUILD_JOB_TYPE) as {
      type: string; state: string; idempotency_key: string; payload_json: string;
    };
    expect(job.state).toBe('queued');
    const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({
      formatVersion: 1,
      prospectId: 'refresh-missing-prospect',
      ruleVersionId: 'founder-priority-v1',
      founderTimezone: 'America/New_York',
      evaluatedAt: BOOT_AT,
      expectedProjectionVersion: null,
      reasons: ['missing_projection'],
    });
    expect(job.idempotency_key).toBe(deriveRefreshIdempotencyKey({
      prospectId: 'refresh-missing-prospect',
      ruleVersionId: 'founder-priority-v1',
      founderLocalDate: '2026-08-30',
      refreshFingerprint: payload.refreshFingerprint as string,
    }));
  });

  it('same-local-day restart reuses the exact stored job without duplication', () => {
    seedProspect(database.raw, 'refresh-restart');
    buildRuntime().initialize();
    const report = buildRuntime().initialize();
    expect(report.projectionRefreshCandidateCount).toBe(1);
    expect(report.projectionRebuildsQueued).toBe(0);
    expect(report.pendingProjectionRebuilds).toBe(1);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM jobs WHERE type = ?',
    ).get(PRIORITY_PROJECTION_REBUILD_JOB_TYPE)).toEqual({ count: 1 });
  });

  it('a current same-day projection produces no refresh candidate', () => {
    const prospect = seedProspect(database.raw, 'refresh-current');
    addDirectPhone(prospect, 'refresh-current-phone');
    buildRuntime().initialize();
    const { priorities } = buildPrioritizationStack();
    priorities.recalculateProspect({
      evaluationId: 'refresh-current-eval',
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: BOOT_AT,
      expectedProjectionVersion: null,
    });
    // A fresh restart on the same local day sees a current projection.
    const report = buildRuntime().initialize();
    // The prior missing-projection job predates the recalculation; only the
    // candidate count matters for the fresh scan.
    expect(report.projectionRefreshCandidateCount).toBe(0);
  });

  it('changed relevant input yields a new fingerprint and a second exact job', () => {
    const prospect = seedProspect(database.raw, 'refresh-changed');
    buildRuntime().initialize();
    const first = database.raw.prepare(`
      SELECT idempotency_key FROM jobs WHERE type = ?
    `).get(PRIORITY_PROJECTION_REBUILD_JOB_TYPE) as { idempotency_key: string };
    // A new property changes the qualified-input fingerprint.
    database.raw.prepare(`
      INSERT INTO properties (
        id, address_line_1, locality, region, country_code, door_count,
        created_at, updated_at
      ) VALUES ('refresh-changed-prop', '1 Main', 'Providence', 'RI', 'US', 10, ?, ?)
    `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO prospect_properties (prospect_id, property_id, created_at)
      VALUES (?, 'refresh-changed-prop', ?)
    `).run(prospect.prospectId, DOMAIN_TIMESTAMP);
    const report = buildRuntime().initialize();
    expect(report.projectionRebuildsQueued).toBe(1);
    const keys = database.raw.prepare(`
      SELECT idempotency_key FROM jobs WHERE type = ? ORDER BY created_at
    `).all(PRIORITY_PROJECTION_REBUILD_JOB_TYPE) as { idempotency_key: string }[];
    expect(keys).toHaveLength(2);
    expect(keys[1]!.idempotency_key).not.toBe(first.idempotency_key);
  });

  it('excludes corrupt projections from refresh and reports them as blocking', () => {
    const prospect = seedProspect(database.raw, 'refresh-corrupt');
    addDirectPhone(prospect, 'refresh-corrupt-phone');
    buildRuntime().initialize();
    const { priorities } = buildPrioritizationStack();
    priorities.recalculateProspect({
      evaluationId: 'refresh-corrupt-eval',
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: BOOT_AT,
      expectedProjectionVersion: null,
    });
    // Corrupt the stored evaluation result envelope.
    database.raw.exec('DROP TRIGGER immutable_prioritization_evaluations');
    database.raw.prepare(`
      UPDATE prioritization_evaluations SET result_json = 'not-json'
      WHERE id = 'refresh-corrupt-eval'
    `).run();
    database.raw.exec(`
      CREATE TRIGGER immutable_prioritization_evaluations
      BEFORE UPDATE ON prioritization_evaluations
      BEGIN
        SELECT RAISE(ABORT, 'prioritization_evaluations rows are immutable');
      END
    `);
    const report = buildRuntime().initialize();
    expect(report.status).toBe('blocked');
    expect(report.violations).toContainEqual(expect.objectContaining({
      kind: 'priority_projection_corrupt',
      recordId: prospect.prospectId,
    }));
    // No rebuild job was enqueued for the corrupt prospect this run.
    expect(report.projectionRebuildsQueued).toBe(0);
  });

  it('canonical fingerprints are stable under key order', () => {
    expect(fingerprintCanonical({ b: 1, a: 2 })).toBe(fingerprintCanonical({ a: 2, b: 1 }));
    expect(fingerprintCanonical({ a: [1, 2] })).not.toBe(fingerprintCanonical({ a: [2, 1] }));
  });

  it('installs the built-in rule with its exact hash before scanning', () => {
    seedProspect(database.raw, 'refresh-hash');
    buildRuntime().initialize();
    const row = database.raw.prepare(`
      SELECT content_hash FROM prioritization_rule_versions WHERE id = 'founder-priority-v1'
    `).get() as { content_hash: string };
    expect(row.content_hash).toBe(BUILTIN_PRIORITIZATION_RULE_V1.contentHash);
  });
});
