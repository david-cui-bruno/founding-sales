import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import { OutboundPermissionService } from '../../src/main/domain/optOut/outboundPermissionService';
import { todaySelectedCallReceiptV1Schema } from '../../src/main/domain/optOut/optOutTypes';
import {
  DomainRepositoryDatabaseMismatchError,
  DomainTransactionRequiredError,
  OutboundContactBlockedError,
} from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

describe('OutboundPermissionService', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let identities: IdentityRepository;
  let optOuts: OptOutRepository;
  let permissions: OutboundPermissionService;
  let id = 0;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const dependencies = {
      database, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
      ids: { next: () => `generated-${++id}` },
    };
    identities = new IdentityRepository(dependencies);
    optOuts = new OptOutRepository({ database, unitOfWork });
    permissions = new OutboundPermissionService({
      database, unitOfWork, identities, optOuts,
    });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function createPerson(phone: string): string {
    return unitOfWork.immediate(() => {
      const person = identities.createPerson({ displayName: `Person ${id}` });
      identities.addContactMethod({
        personId: person.id, kind: 'phone', normalizedValue: phone,
        validationState: 'valid', reachability: 'direct',
      });
      return person.id;
    });
  }

  function block(personId: string, phone: string, tombstoneId: string): void {
    const activityId = `${tombstoneId}-activity`;
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at, observed_outcome,
        metadata_json, created_at
      ) VALUES (?, ?, 'text', 'inbound', 'imessage', ?, 'opted_out', '{}', ?)
    `).run(activityId, personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    unitOfWork.immediate(() => {
      optOuts.insertTombstone({
        id: tombstoneId, personId, requestedAt: DOMAIN_TIMESTAMP,
        observedChannel: 'imessage', sourceActivityId: activityId, evidenceRef: null,
        policyVersion: 'founder_opt_out_v1', createdAt: DOMAIN_TIMESTAMP,
      });
      optOuts.insertBlockedHandle({
        id: `${tombstoneId}-handle`, tombstoneId, kind: 'phone',
        normalizedValue: phone, createdAt: DOMAIN_TIMESTAMP,
      });
    });
  }

  it('inspects Person and every handle on each read and blocks re-imported identities', () => {
    const blockedPerson = createPerson('+14015550100');
    block(blockedPerson, '+14015550100', 'blocked-tombstone');
    const reimported = createPerson('+14015550100');
    const clean = createPerson('+14015550101');

    expect(permissions.inspectPerson(clean)).toEqual({ kind: 'allowed' });
    expect(permissions.inspectPerson(blockedPerson)).toEqual({
      kind: 'blocked', tombstoneIds: ['blocked-tombstone'],
      matchedHandles: [{ kind: 'phone', normalizedValue: '+14015550100' }],
    });
    expect(permissions.inspectPerson(reimported)).toEqual({
      kind: 'blocked', tombstoneIds: ['blocked-tombstone'],
      matchedHandles: [{ kind: 'phone', normalizedValue: '+14015550100' }],
    });
    expect(() => permissions.assertMayContactHandle('phone', '(401) 555-0100'))
      .toThrow(OutboundContactBlockedError);
  });

  it('requires an exact active scope for authoritative execution and exposes no contact values', () => {
    const personId = createPerson('+14015550100');
    block(personId, '+14015550100', 'execute-tombstone');
    expect(() => permissions.assertMayExecuteOutbound({
      personId, target: { kind: 'phone', normalizedValue: '+14015550100' },
    })).toThrow(DomainTransactionRequiredError);

    let thrown: unknown;
    unitOfWork.immediate(() => {
      try {
        permissions.assertMayExecuteOutbound({
          personId, target: { kind: 'phone', normalizedValue: '+14015550100' },
        });
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toMatchObject({
      reasonCode: 'person_or_handle_opted_out', tombstoneIds: ['execute-tombstone'],
    });
    expect(JSON.stringify(thrown)).not.toContain('+14015550100');
  });

  it('rejects mixed repository/service bindings before reads', () => {
    const otherUnit = new DomainUnitOfWork(database);
    expect(() => new OutboundPermissionService({
      database, unitOfWork: otherUnit, identities, optOuts,
    })).toThrow(DomainRepositoryDatabaseMismatchError);
    expect(() => permissions.assertBoundTo(database, otherUnit))
      .toThrow(DomainRepositoryDatabaseMismatchError);
  });

  it('strictly validates the deferred Today selected-call receipt envelope', () => {
    const canonical = {
      version: 1 as const, kind: 'discretionary_call' as const,
      currentActionId: 'action-1', queueGeneratedAt: DOMAIN_TIMESTAMP,
      queueTimezone: 'America/New_York', queueLocalDate: '2026-08-30',
    };
    expect(todaySelectedCallReceiptV1Schema.parse(canonical)).toEqual(canonical);
    expect(() => todaySelectedCallReceiptV1Schema.parse({ ...canonical, extra: true })).toThrow();
    expect(() => todaySelectedCallReceiptV1Schema.parse({
      ...canonical, queueLocalDate: '08/30/2026',
    })).toThrow();
    expect(() => todaySelectedCallReceiptV1Schema.parse({
      ...canonical, queueTimezone: 'Not/AZone',
    })).toThrow();
    expect(() => todaySelectedCallReceiptV1Schema.parse({
      ...canonical, queueLocalDate: '2026-08-29',
    })).toThrow();
  });

  it('validates selected-call receipts only for the still-current discretionary call', () => {
    const prospect = seedProspect(database.raw, 'selected-call');
    database.raw.exec('BEGIN IMMEDIATE');
    try {
      database.raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
          current_next_action_id, stage_entered_at, version, created_at, updated_at
        ) VALUES ('selected-cycle', ?, ?, ?, 'ready', 'active', 'selected-action',
                  ?, 1, ?, ?)
      `).run(
        prospect.personId, prospect.prospectId, prospect.sourceEventId,
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at, timezone,
          work_intent, version, created_at, updated_at
        ) VALUES ('selected-action', 'selected-cycle', 'call', 'phone', 'pending', ?,
                  'America/New_York', 'discretionary_prospecting', 1, ?, ?)
      `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      database.raw.exec('COMMIT');
    } catch (error) {
      if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
      throw error;
    }
    const receipt = {
      version: 1 as const, kind: 'discretionary_call' as const,
      currentActionId: 'selected-action', queueGeneratedAt: DOMAIN_TIMESTAMP,
      queueTimezone: 'America/New_York', queueLocalDate: '2026-08-30',
    };
    unitOfWork.immediate(() => permissions.assertCurrentSelectedCallReceipt({
      personId: prospect.personId, receipt,
    }));
    expect(() => unitOfWork.immediate(() => permissions.assertCurrentSelectedCallReceipt({
      personId: prospect.personId,
      receipt: { ...receipt, currentActionId: 'stale-action' },
    }))).toThrow();
  });
});
