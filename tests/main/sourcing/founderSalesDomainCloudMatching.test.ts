import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../src/main/db/database';
import { migrateToLatest } from '../../../src/main/db/migrate';
import {
  createDomainServices,
  type DomainServices,
} from '../../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  type FounderSalesDomain,
} from '../../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../../src/main/domain/prioritization/builtinPrioritizationRules';
import { cloudReceiptKey, mapCloudSourceEvent } from '../../../src/main/sourcing/intakeMapper';
import type { CloudSourceEvent } from '../../../src/shared/contracts/cloudSourceEventContract';
import { validParcelEvent } from '../../fixtures/cloudSourceEvents';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../../fixtures/tempDatabase';

const NOW = '2026-08-31T15:00:00.000Z';

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

/**
 * A contact-less public-record event: the live duplicate shape. Identity can
 * only converge through the cloud entity link or the display-name fallback.
 */
function contactlessCloudEvent(input: {
  idempotencyKey: string;
  cloudEntityId: string;
  channel?: 'parcel' | 'deed' | 'permit' | 'violation';
  fullName: string;
}): CloudSourceEvent {
  const base = validParcelEvent();
  return {
    ...base,
    idempotency_key: input.idempotencyKey,
    channel: input.channel ?? 'parcel',
    entity: {
      ...base.entity,
      cloud_entity_id: input.cloudEntityId,
      person: {
        ...base.entity.person,
        full_name: input.fullName,
        phones: [],
        emails: [],
        org_names: [],
      },
    },
  };
}

describe('FounderSalesDomain cloud identity matching', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    const clock = { now: () => NOW };
    const ids = new SequentialIds();
    services = createDomainServices({ database, clock, ids });
    services.unitOfWork.immediate(() => {
      const installed = services.prioritizationRepository
        .installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      services.prioritizationRepository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
      services.cadences.installBuiltins();
    });
    domain = createFounderSalesDomain({ services, database, clock, ids });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function importEvent(event: CloudSourceEvent) {
    const mapped = mapCloudSourceEvent(event);
    if (mapped.kind !== 'intake') throw new Error('expected intake');
    return domain.importCloudSourceEvent({
      command: mapped.command,
      cloudEntityId: mapped.cloudEntityId,
    });
  }

  function count(table: string): number {
    return (database.raw.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).get() as { count: number }).count;
  }

  it('matches the existing person when the same cloudEntityId arrives twice', () => {
    const first = importEvent(contactlessCloudEvent({
      idempotencyKey: 'c'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000AA',
      channel: 'parcel',
      fullName: '212 LLC',
    }));
    // The concurrently-fixed cloud sends deterministic entity ids, so a later
    // violation event for the same owner reuses the SAME cloud entity id even
    // though the person block differs (here: a different display name).
    const second = importEvent(contactlessCloudEvent({
      idempotencyKey: 'd'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000AA',
      channel: 'violation',
      fullName: '212, LLC.',
    }));

    expect(first.disposition).toBe('created');
    expect(second.disposition).toBe('matched_existing');
    expect(second.personId).toBe(first.personId);
    expect(count('persons')).toBe(1);
    expect(count('prospects')).toBe(1);
    expect(count('sales_cycles')).toBe(1);
    expect(count('source_events')).toBe(2);
    expect(count('source_intake_receipts')).toBe(2);
    expect(count('cloud_entity_links')).toBe(1);
    expect(database.raw.prepare(
      'SELECT person_id FROM source_events WHERE id = ?',
    ).get(second.sourceEventId)).toEqual({ person_id: first.personId });
  });

  it('matches on normalized display name across different cloud entity ids and links both', () => {
    const first = importEvent(contactlessCloudEvent({
      idempotencyKey: 'c'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000AA',
      channel: 'parcel',
      fullName: '212 LLC',
    }));
    const second = importEvent(contactlessCloudEvent({
      idempotencyKey: 'd'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000BB',
      channel: 'violation',
      fullName: '  212,  llc. ',
    }));

    expect(second.disposition).toBe('matched_existing');
    expect(second.personId).toBe(first.personId);
    expect(count('persons')).toBe(1);
    expect(count('prospects')).toBe(1);
    expect(database.raw.prepare<[], { cloud_entity_id: string; person_id: string }>(
      'SELECT cloud_entity_id, person_id FROM cloud_entity_links ORDER BY cloud_entity_id',
    ).all()).toEqual([
      { cloud_entity_id: 'ce_01JC00000000000000000000AA', person_id: first.personId },
      { cloud_entity_id: 'ce_01JC00000000000000000000BB', person_id: first.personId },
    ]);
  });

  it('never name-matches a manually-created person without a cloud entity link', () => {
    const manual = services.sources.createPersonProspect({
      person: { displayName: '212 LLC' },
      contacts: [{
        kind: 'phone', value: '+14015550123', reachability: 'direct', isPrimary: true,
      }],
      source: {
        id: 'manual-source-1',
        observedAt: NOW,
        sourceRecord: { manual: true },
        channel: 'custom',
        customSourceReason: 'manual_quick_add',
      },
      segment: 'warm',
    });

    const imported = importEvent(contactlessCloudEvent({
      idempotencyKey: 'c'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000AA',
      channel: 'parcel',
      fullName: '212 LLC',
    }));

    expect(imported.disposition).toBe('created');
    expect(imported.personId).not.toBe(manual.personId);
    expect(count('persons')).toBe(2);
  });

  it('creates a new person when the name fallback is ambiguous', () => {
    const first = importEvent(contactlessCloudEvent({
      idempotencyKey: 'c'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000AA',
      channel: 'parcel',
      fullName: '212 LLC',
    }));
    const second = importEvent(contactlessCloudEvent({
      idempotencyKey: 'd'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000BB',
      channel: 'parcel',
      fullName: 'OTHER OWNER',
    }));
    // Two distinct cloud-linked persons sharing one normalized name is the
    // pre-fix corruption shape; force it so the third arrival is ambiguous.
    database.raw.prepare(
      'UPDATE persons SET display_name = ? WHERE id = ?',
    ).run('212 LLC', second.personId);

    const third = importEvent(contactlessCloudEvent({
      idempotencyKey: 'e'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000CC',
      channel: 'violation',
      fullName: '212 LLC',
    }));

    expect(third.disposition).toBe('created');
    expect(third.personId).not.toBe(first.personId);
    expect(third.personId).not.toBe(second.personId);
    expect(count('persons')).toBe(3);
  });

  it('keeps replays of an append-path import idempotent', () => {
    importEvent(contactlessCloudEvent({
      idempotencyKey: 'c'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000AA',
      channel: 'parcel',
      fullName: '212 LLC',
    }));
    const appended = importEvent(contactlessCloudEvent({
      idempotencyKey: 'd'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000AA',
      channel: 'violation',
      fullName: '212 LLC',
    }));

    const replay = importEvent(contactlessCloudEvent({
      idempotencyKey: 'd'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000AA',
      channel: 'violation',
      fullName: '212 LLC',
    }));

    expect(appended.replayed).toBe(false);
    expect(replay).toEqual({ ...appended, replayed: true });
    expect(count('source_events')).toBe(2);
    expect(count('source_intake_receipts')).toBe(2);
    expect(count('sales_cycles')).toBe(1);
  });

  it('lands a later score update through the append-path receipt', () => {
    const first = importEvent(contactlessCloudEvent({
      idempotencyKey: 'c'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000AA',
      channel: 'parcel',
      fullName: '212 LLC',
    }));
    const appended = importEvent(contactlessCloudEvent({
      idempotencyKey: 'd'.repeat(64),
      cloudEntityId: 'ce_01JC00000000000000000000AA',
      channel: 'violation',
      fullName: '212, LLC.',
    }));
    expect(appended.prospectId).toBe(first.prospectId);

    const applied = domain.applyCloudScoreUpdate({
      receiptKey: cloudReceiptKey('d'.repeat(64)),
      scoresVersion: 1,
      fit: 82,
      timing: 64,
      reasons: [{ signal: 'violation_opened', contribution: 0.6 }],
    });

    expect(applied).toBe(true);
    expect(database.raw.prepare<[string], {
      cloud_fit: number; cloud_timing: number; cloud_scores_version: number;
    }>(
      'SELECT cloud_fit, cloud_timing, cloud_scores_version FROM prospects WHERE id = ?',
    ).get(first.prospectId)).toEqual({
      cloud_fit: 82,
      cloud_timing: 64,
      cloud_scores_version: 1,
    });
  });
});
