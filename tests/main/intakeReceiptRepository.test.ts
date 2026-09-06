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
      INSERT INTO prospects (
        id, person_id, original_source_event_id, segment, qualification_state,
        version, created_at, updated_at
      ) VALUES (
        'prospect', 'person', '${id}', 'hot', 'unreviewed',
        1, '${NOW}', '${NOW}'
      );
      INSERT INTO properties (
        id, address_line_1, locality, region, country_code, created_at, updated_at
      ) VALUES (
        'property', '10 hope st', 'providence', 'ri', 'US', '${NOW}', '${NOW}'
      );
      INSERT INTO prospect_properties (prospect_id, property_id, created_at)
      VALUES ('prospect', 'property', '${NOW}');
    `);
  }

  function insertRawReceipt(input: {
    command?: CanonicalIntakeCommand;
    result?: StoredIntakeResult;
    commandJson?: string;
    resultJson?: string;
  } = {}): void {
    const receiptCommand = input.command ?? command();
    const receiptResult = input.result ?? result();
    database.raw.prepare(`
      INSERT INTO source_intake_receipts (
        source_event_id, person_id, prospect_id,
        command_json, result_json, created_at
      ) VALUES ('source', 'person', 'prospect', ?, ?, ?)
    `).run(
      input.commandJson ?? canonicalJson({ formatVersion: 1, command: receiptCommand }),
      input.resultJson ?? canonicalJson({ formatVersion: 1, result: receiptResult }),
      NOW,
    );
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
      segment: 'hot',
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
      personId: 'person',
      prospectId: 'prospect',
      command: command(),
      commandJson: serializeCanonicalIntakeCommand(command()),
      result: result(),
      createdAt: NOW,
    });
    expect(repository.getBySourceEventId('source')).toEqual(receipt);
    expect(JSON.parse(receipt.commandJson)).toMatchObject({ formatVersion: 1 });
    const stored = database.raw.prepare(`
      SELECT person_id, prospect_id, command_json, result_json
      FROM source_intake_receipts
    `).get() as {
      person_id: string;
      prospect_id: string;
      command_json: string;
      result_json: string;
    };
    expect(stored).toMatchObject({ person_id: 'person', prospect_id: 'prospect' });
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

  it('includes validation and presentation evidence in deterministic receipt identity', () => {
    const first: CanonicalIntakeCommand = {
      ...command(),
      contacts: [{
        ...command().contacts[0]!,
        validationState: 'unverified',
        presentationEvidence: {
          sourceLabel: 'tracerfy', vendorRank: 1, phoneKind: 'mobile',
          ownershipState: 'vendor_candidate', evidenceObservedAt: OBSERVED_AT,
        },
      }],
    };
    const equivalent: CanonicalIntakeCommand = {
      ...first,
      contacts: [...first.contacts].reverse(),
    };
    const changed: CanonicalIntakeCommand = {
      ...first,
      contacts: [{ ...first.contacts[0]!, validationState: 'valid' }],
    };

    expect(serializeCanonicalIntakeCommand(first))
      .toBe(serializeCanonicalIntakeCommand(equivalent));
    expect(serializeCanonicalIntakeCommand(first))
      .not.toBe(serializeCanonicalIntakeCommand(changed));
    expect(JSON.parse(serializeCanonicalIntakeCommand(first))).toMatchObject({
      command: { contacts: [{
        validationState: 'unverified',
        presentationEvidence: {
          sourceLabel: 'tracerfy', vendorRank: 1, phoneKind: 'mobile',
          ownershipState: 'vendor_candidate', evidenceObservedAt: OBSERVED_AT,
        },
      }] },
    });
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

  type ReceiptChange = {
    command?: CanonicalIntakeCommand;
    result?: StoredIntakeResult;
    before?: () => unknown;
  };
  const appendIntegrityCases: Array<[string, ReceiptChange]> = [
    ['result person', { result: { ...result(), personId: 'ghost-person' } }],
    ['result prospect', { result: { ...result(), prospectId: 'ghost-prospect' } }],
    ['source payload', {
      command: { ...command(), source: { ...command().source, channel: 'registry' as const } },
    }],
    ['ghost context', { result: { ...result(), organizationIds: ['ghost-organization'] } }],
    ['duplicate context IDs', { result: { ...result(), propertyIds: ['property', 'property'] } }],
    ['unstable context order', { result: { ...result(), organizationIds: ['z', 'a'] } }],
    ['forged merge-review projection', {
      result: {
        ...result(),
        disposition: 'created_merge_review',
        identityReviewReason: 'shared_handle',
      },
    }],
  ];
  it.each(appendIntegrityCases)(
    'rejects inconsistent %s before appending a receipt',
    (_label, changed) => {
    expect(() => unitOfWork.immediate(() => repository.append({
      sourceEventId: 'source',
      command: changed.command ?? command(),
      result: changed.result ?? result(),
    }))).toThrow(expect.objectContaining({ name: 'IntakeReceiptIntegrityError' }));
    expect(database.raw.prepare(`
      SELECT count(*) AS count FROM source_intake_receipts
    `).get()).toEqual({ count: 0 });
    },
  );

  const readIntegrityCases: Array<[string, ReceiptChange]> = [
    ['JSON person ownership', { result: { ...result(), personId: 'ghost-person' } }],
    ['JSON prospect ownership', { result: { ...result(), prospectId: 'ghost-prospect' } }],
    ['source payload', {
      command: { ...command(), source: { ...command().source, observedAt: NOW } },
    }],
    ['ghost organization context', {
      result: { ...result(), organizationIds: ['ghost-organization'] },
    }],
    ['ghost property context', {
      result: { ...result(), propertyIds: ['ghost-property'] },
    }],
    ['duplicate context IDs', {
      result: { ...result(), propertyIds: ['property', 'property'] },
    }],
  ];
  it.each(readIntegrityCases)('fails closed reading inconsistent %s', (_label, changed) => {
    changed.before?.();
    insertRawReceipt({
      command: changed.command ?? command(),
      result: changed.result ?? result(),
    });

    expect(() => repository.getBySourceEventId('source')).toThrow(expect.objectContaining({
      name: 'IntakeReceiptIntegrityError',
    }));
  });

  it.each([
    ['created merge-review without a reason', {
      ...result(), disposition: 'created_merge_review', identityReviewReason: null,
    }],
    ['created with a review reason', {
      ...result(), disposition: 'created', identityReviewReason: 'shared_handle',
    }],
  ] as const)('fails closed reading %s despite canonical envelope bytes', (_label, invalid) => {
    insertRawReceipt({ result: invalid });

    expect(() => repository.getBySourceEventId('source')).toThrow(expect.objectContaining({
      name: 'IntakeReceiptIntegrityError', reason: 'identity_review_mismatch',
    }));
  });

  it('keeps historical receipt context readable after a supported link correction', () => {
    database.raw.exec(`
      INSERT INTO organizations (id, canonical_name, created_at, updated_at)
      VALUES ('organization', 'Historical LLC', '${NOW}', '${NOW}');
      INSERT INTO prospect_organizations (prospect_id, organization_id, created_at)
      VALUES ('prospect', 'organization', '${NOW}');
    `);
    const historicalResult = { ...result(), organizationIds: ['organization'] };
    const receipt = unitOfWork.immediate(() => repository.append({
      sourceEventId: 'source', command: command(), result: historicalResult,
    }));
    database.raw.exec(`
      DELETE FROM prospect_properties
      WHERE prospect_id = 'prospect' AND property_id = 'property';
      DELETE FROM prospect_organizations
      WHERE prospect_id = 'prospect' AND organization_id = 'organization';
    `);

    expect(repository.getBySourceEventId('source')).toEqual(receipt);
  });

  it.each(['command', 'result'] as const)(
    'rejects semantically valid but noncanonical %s envelope bytes',
    (envelope) => {
      const commandEnvelope = { formatVersion: 1, command: command() };
      const resultEnvelope = { formatVersion: 1, result: result() };
      insertRawReceipt({
        commandJson: envelope === 'command'
          ? JSON.stringify(commandEnvelope, null, 2)
          : canonicalJson(commandEnvelope),
        resultJson: envelope === 'result'
          ? JSON.stringify({ result: result(), formatVersion: 1 })
          : canonicalJson(resultEnvelope),
      });

      expect(() => repository.getBySourceEventId('source')).toThrow(expect.objectContaining({
        name: 'IntakeReceiptIntegrityError',
        reason: envelope === 'command'
          ? 'noncanonical_command_json'
          : 'noncanonical_result_json',
      }));
    },
  );

  it.each([
    ['command_json', '{"formatVersion":2,"command":{}}'],
    ['command_json', '{not json'],
    ['result_json', '{"formatVersion":2,"result":{}}'],
    ['result_json', '{not json'],
  ] as const)('fails closed on malformed or unknown-version stored %s', (column, value) => {
    const validCommand = canonicalJson({ formatVersion: 1, command: command() }).replaceAll("'", "''");
    const validResult = canonicalJson({ formatVersion: 1, result: result() }).replaceAll("'", "''");
    database.raw.exec(`
      INSERT INTO source_intake_receipts (
        source_event_id, person_id, prospect_id, command_json, result_json, created_at
      ) VALUES (
        'source', 'person', 'prospect',
        '${column === 'command_json' ? value : validCommand}',
        '${column === 'result_json' ? value : validResult}',
        '${NOW}'
      )
    `);

    expect(() => repository.getBySourceEventId('source')).toThrow(z.ZodError);
  });
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalObject));
  return JSON.stringify(canonicalObject(value));
}

function canonicalObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalObject(child)]));
  }
  return value;
}
