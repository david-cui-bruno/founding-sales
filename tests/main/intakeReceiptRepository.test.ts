import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  IntakeReceiptRepository,
  serializeCanonicalIntakeCommand,
  type CanonicalIntakeCommand,
  type StoredIntakeResult,
} from '../../src/main/domain/source/intakeReceiptRepository';
import {
  DomainRepositoryDatabaseMismatchError,
  DomainTransactionRequiredError,
} from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const NOW = '2026-08-30T12:00:00.000Z';
const OBSERVED_AT = '2026-08-29T16:30:00.000Z';

describe('IntakeReceiptRepository', () => {
  let database: AppDatabase;
  let tempDatabase: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let repository: IntakeReceiptRepository;

  beforeEach(async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    repository = new IntakeReceiptRepository({
      database,
      unitOfWork,
      clock: { now: () => NOW },
    });
    insertSourceEvent('source');
  });

  afterEach(() => {
    closeDatabase(database);
    tempDatabase.cleanup();
  });

  function insertSourceEvent(id: string): void {
    database.raw.exec(`
      INSERT INTO persons (
        id, display_name, aliases_json, opted_out, never_record,
        version, created_at, updated_at
      ) VALUES ('person', 'Person', '[]', 0, 0, 1, '${NOW}', '${NOW}');
      INSERT INTO source_events (
        id, person_id, channel, observed_at, source_record_json, created_at
      ) VALUES (
        '${id}', 'person', 'frbo', '${OBSERVED_AT}',
        '{"customSourceReason":null,"formatVersion":1,"sourceRecord":{"listingId":"one"}}',
        '${NOW}'
      );
    `);
  }

  function command(): CanonicalIntakeCommand {
    return {
      person: {
        displayName: 'Kevin Shin', aliases: [], neverRecord: false, provenance: null,
      },
      contacts: [{
        kind: 'phone', normalizedValue: '+14015550100', reachability: 'direct',
        isPrimary: true, inContacts: null,
      }],
      organizations: [],
      properties: [],
      source: {
        id: 'source', channel: 'frbo', observedAt: OBSERVED_AT,
        sourceRecord: { listingId: 'one' }, evidenceRef: null,
        referral: null, customSourceReason: null,
      },
      segment: 'hot_frbo',
    };
  }

  function result(): StoredIntakeResult {
    return {
      disposition: 'created',
      personId: 'person',
      prospectId: 'prospect',
      sourceEventId: 'source',
      identityReviewReason: null,
      contextReviewReasons: ['organization_not_found'],
      organizationIds: [],
      propertyIds: ['property'],
    };
  }

  it('roundtrips strict versioned canonical command and exact result envelopes', () => {
    const receipt = unitOfWork.immediate(() => repository.append({
      sourceEventId: 'source', command: command(), result: result(),
    }));

    expect(receipt).toEqual({
      sourceEventId: 'source',
      command: command(),
      commandJson: serializeCanonicalIntakeCommand(command()),
      result: result(),
      createdAt: NOW,
    });
    expect(repository.getBySourceEventId('source')).toEqual(receipt);
    expect(JSON.parse(receipt.commandJson)).toMatchObject({ formatVersion: 1 });
    const stored = database.raw.prepare(`
      SELECT command_json, result_json FROM source_intake_receipts
    `).get() as { command_json: string; result_json: string };
    expect(JSON.parse(stored.command_json)).toMatchObject({ formatVersion: 1 });
    expect(JSON.parse(stored.result_json)).toEqual({ formatVersion: 1, result: result() });
  });

  it('canonicalizes object key order and semantically unordered command collections', () => {
    const first = command();
    const second: CanonicalIntakeCommand = {
      ...first,
      person: { ...first.person, aliases: ['z alias', 'a alias'] },
      contacts: [
        { kind: 'email', normalizedValue: 'k@example.com', reachability: 'direct', isPrimary: false, inContacts: false },
        ...first.contacts,
      ],
      source: { ...first.source, sourceRecord: { nested: { b: 2, a: 1 }, listingId: 'one' } },
    };
    const reordered: CanonicalIntakeCommand = {
      ...second,
      person: { ...second.person, aliases: ['a alias', 'z alias'] },
      contacts: [...second.contacts].reverse(),
      source: { ...second.source, sourceRecord: { listingId: 'one', nested: { a: 1, b: 2 } } },
    };

    expect(serializeCanonicalIntakeCommand(second))
      .toBe(serializeCanonicalIntakeCommand(reordered));
  });

  it('requires its own active write scope and matching database', async () => {
    expect(() => repository.append({
      sourceEventId: 'source', command: command(), result: result(),
    })).toThrow(DomainTransactionRequiredError);

    const otherTemp = createTempDatabase();
    const otherKey = createTestWorkspaceKey();
    const otherDatabase = openDatabase({ path: otherTemp.path, key: otherKey });
    try {
      await migrateToLatest(otherDatabase, {
        backupDirectory: `${otherTemp.path}.backups`, workspaceKey: otherKey,
      });
      expect(() => new IntakeReceiptRepository({
        database,
        unitOfWork: new DomainUnitOfWork(otherDatabase),
        clock: { now: () => NOW },
      })).toThrow(DomainRepositoryDatabaseMismatchError);
    } finally {
      closeDatabase(otherDatabase);
      otherTemp.cleanup();
    }
  });

  it('uses a plain insert and lets duplicate/FK constraints propagate', () => {
    unitOfWork.immediate(() => repository.append({
      sourceEventId: 'source', command: command(), result: result(),
    }));
    expect(() => unitOfWork.immediate(() => repository.append({
      sourceEventId: 'source', command: command(), result: result(),
    }))).toThrow();
    expect(() => unitOfWork.immediate(() => repository.append({
      sourceEventId: 'missing',
      command: { ...command(), source: { ...command().source, id: 'missing' } },
      result: { ...result(), sourceEventId: 'missing' },
    }))).toThrow();
  });

  it.each([
    ['command_json', '{"formatVersion":2,"command":{}}'],
    ['command_json', '{not json'],
    ['result_json', '{"formatVersion":2,"result":{}}'],
    ['result_json', '{not json'],
  ] as const)('fails closed on malformed or unknown-version stored %s', (column, value) => {
    const validCommand = serializeCanonicalIntakeCommand(command()).replaceAll("'", "''");
    const validResult = JSON.stringify({ formatVersion: 1, result: result() }).replaceAll("'", "''");
    database.raw.exec(`
      INSERT INTO source_intake_receipts (
        source_event_id, command_json, result_json, created_at
      ) VALUES (
        'source',
        '${column === 'command_json' ? value : validCommand}',
        '${column === 'result_json' ? value : validResult}',
        '${NOW}'
      )
    `);

    expect(() => repository.getBySourceEventId('source')).toThrow(z.ZodError);
  });
});
