import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  SourceEventIdempotencyConflictError,
  SourceRepository,
} from '../../src/main/domain/source/sourceRepository';
import { DomainTransactionRequiredError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const CREATED_AT = '2026-08-30T12:00:00.000Z';
const OBSERVED_AT = '2026-08-29T16:30:00.000Z';

describe('SourceRepository', () => {
  let database: AppDatabase;
  let tempDatabase: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let repository: SourceRepository;

  beforeEach(async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    repository = new SourceRepository({
      database,
      unitOfWork,
      clock: { now: () => CREATED_AT },
    });
    insertPerson('subject');
    insertPerson('referrer');
  });

  afterEach(() => {
    closeDatabase(database);
    tempDatabase.cleanup();
  });

  function insertPerson(id: string): void {
    database.raw.prepare(`
      INSERT INTO persons (
        id, display_name, aliases_json, opted_out, never_record,
        version, created_at, updated_at
      ) VALUES (?, ?, '[]', 0, 0, 1, ?, ?)
    `).run(id, id, CREATED_AT, CREATED_AT);
  }

  it.each([
    'frbo',
    'registry',
    'rireig',
    'inbound_demo',
    'community',
  ] as const)('roundtrips the %s source channel', (channel) => {
    const event = unitOfWork.immediate(() => repository.append({
      id: `source-${channel}`,
      personId: 'subject',
      channel,
      observedAt: OBSERVED_AT,
      sourceRecord: { listing: channel, nested: { count: 2 } },
      evidenceRef: ' local://evidence/one ',
    }));

    expect(event).toEqual({
      id: `source-${channel}`,
      personId: 'subject',
      prospectId: null,
      salesCycleId: null,
      channel,
      observedAt: OBSERVED_AT,
      sourceRecord: { listing: channel, nested: { count: 2 } },
      evidenceRef: 'local://evidence/one',
      referral: null,
      customSourceReason: null,
      createdAt: CREATED_AT,
    });
    expect(repository.getById(event.id)).toEqual(event);
  });

  it('roundtrips known and explicitly unknown referrals', () => {
    const known = unitOfWork.immediate(() => repository.append({
      id: 'known-referral',
      personId: 'subject',
      channel: 'referral',
      observedAt: OBSERVED_AT,
      sourceRecord: { introduction: 'email' },
      referral: { kind: 'known', referredByPersonId: 'referrer' },
    }));
    const unknown = unitOfWork.immediate(() => repository.append({
      id: 'unknown-referral',
      personId: 'subject',
      channel: 'referral',
      observedAt: '2026-08-29T17:00:00.000Z',
      sourceRecord: { introduction: 'forwarded' },
      referral: { kind: 'unknown', reason: 'not_provided' },
    }));

    expect(known.referral).toEqual({ kind: 'known', referredByPersonId: 'referrer' });
    expect(unknown.referral).toEqual({ kind: 'unknown', reason: 'not_provided' });
  });

  it('rejects missing, both-shaped, nonexistent, and self referrals without committing', () => {
    const base = {
      personId: 'subject',
      channel: 'referral' as const,
      observedAt: OBSERVED_AT,
      sourceRecord: { introduction: 'email' },
    };

    expect(() => unitOfWork.immediate(() => repository.append({
      ...base,
      id: 'missing-referral',
    } as never))).toThrow(z.ZodError);
    expect(() => unitOfWork.immediate(() => repository.append({
      ...base,
      id: 'both-referral',
      referral: {
        kind: 'known',
        referredByPersonId: 'referrer',
        reason: 'other',
      },
    } as never))).toThrow(z.ZodError);
    expect(() => unitOfWork.immediate(() => repository.append({
      ...base,
      id: 'missing-person-referral',
      referral: { kind: 'known' as const, referredByPersonId: 'does-not-exist' },
    }))).toThrow();
    expect(() => unitOfWork.immediate(() => repository.append({
      ...base,
      id: 'self-referral',
      referral: { kind: 'known' as const, referredByPersonId: 'subject' },
    }))).toThrow();

    expect(database.raw.prepare('SELECT count(*) AS count FROM source_events').get())
      .toEqual({ count: 0 });
  });

  it('keeps RIREIG distinct from referral and enforces custom-source reasons', () => {
    expect(() => unitOfWork.immediate(() => repository.append({
      id: 'rireig-with-referral',
      personId: 'subject',
      channel: 'rireig',
      observedAt: OBSERVED_AT,
      sourceRecord: { event: 'monthly-meetup' },
      referral: { kind: 'known', referredByPersonId: 'referrer' },
    } as never))).toThrow(z.ZodError);
    expect(() => unitOfWork.immediate(() => repository.append({
      id: 'custom-without-reason',
      personId: 'subject',
      channel: 'custom',
      observedAt: OBSERVED_AT,
      sourceRecord: { row: 8 },
    } as never))).toThrow(z.ZodError);
    expect(() => unitOfWork.immediate(() => repository.append({
      id: 'registry-with-reason',
      personId: 'subject',
      channel: 'registry',
      observedAt: OBSERVED_AT,
      sourceRecord: { row: 8 },
      customSourceReason: 'csv_import',
    } as never))).toThrow(z.ZodError);

    const custom = unitOfWork.immediate(() => repository.append({
      id: 'custom-source',
      personId: 'subject',
      channel: 'custom',
      observedAt: OBSERVED_AT,
      sourceRecord: { row: 8 },
      customSourceReason: 'csv_import',
    }));
    expect(custom.customSourceReason).toBe('csv_import');
    expect(JSON.parse((database.raw.prepare(`
      SELECT source_record_json FROM source_events WHERE id = 'custom-source'
    `).get() as { source_record_json: string }).source_record_json)).toEqual({
      customSourceReason: 'csv_import',
      formatVersion: 1,
      sourceRecord: { row: 8 },
    });
  });

  it('uses the stable ID as an exact canonical-payload idempotency key', () => {
    const first = unitOfWork.immediate(() => repository.append({
      id: 'stable-source',
      personId: 'subject',
      channel: 'frbo',
      observedAt: OBSERVED_AT,
      sourceRecord: { z: 1, nested: { b: 2, a: 1 }, a: 2 },
    }));
    const replay = unitOfWork.immediate(() => repository.append({
      id: 'stable-source',
      personId: 'subject',
      channel: 'frbo',
      observedAt: OBSERVED_AT,
      sourceRecord: { a: 2, nested: { a: 1, b: 2 }, z: 1 },
    }));

    expect(replay).toEqual(first);
    expect(database.raw.prepare('SELECT count(*) AS count FROM source_events').get())
      .toEqual({ count: 1 });

    for (const changed of [
      { channel: 'registry' },
      { observedAt: '2026-08-29T16:31:00.000Z' },
      { sourceRecord: { a: 999 } },
      { evidenceRef: 'local://different' },
      { personId: 'referrer' },
      { prospectId: 'different-prospect' },
      { salesCycleId: 'different-cycle' },
    ] as const) {
      expect(() => unitOfWork.immediate(() => repository.append({
        id: 'stable-source',
        personId: 'subject',
        channel: 'frbo',
        observedAt: OBSERVED_AT,
        sourceRecord: { a: 2, nested: { a: 1, b: 2 }, z: 1 },
        ...changed,
      }))).toThrow(SourceEventIdempotencyConflictError);
    }

    unitOfWork.immediate(() => repository.append({
      id: 'stable-custom',
      personId: 'subject',
      channel: 'custom',
      observedAt: OBSERVED_AT,
      sourceRecord: { row: 4 },
      customSourceReason: 'csv_import',
    }));
    expect(() => unitOfWork.immediate(() => repository.append({
      id: 'stable-custom',
      personId: 'subject',
      channel: 'custom',
      observedAt: OBSERVED_AT,
      sourceRecord: { row: 4 },
      customSourceReason: 'spreadsheet_paste',
    }))).toThrow(SourceEventIdempotencyConflictError);

    unitOfWork.immediate(() => repository.append({
      id: 'stable-referral',
      personId: 'subject',
      channel: 'referral',
      observedAt: OBSERVED_AT,
      sourceRecord: { introduction: 'email' },
      referral: { kind: 'known', referredByPersonId: 'referrer' },
    }));
    expect(() => unitOfWork.immediate(() => repository.append({
      id: 'stable-referral',
      personId: 'subject',
      channel: 'referral',
      observedAt: OBSERVED_AT,
      sourceRecord: { introduction: 'email' },
      referral: { kind: 'unknown', reason: 'unresolvable' },
    }))).toThrow(SourceEventIdempotencyConflictError);
  });

  it('lists parsed rows in observed-time then stable-ID order', () => {
    unitOfWork.immediate(() => {
      repository.append({
        id: 'source-z', personId: 'subject', channel: 'community',
        observedAt: OBSERVED_AT, sourceRecord: { id: 'z' },
      });
      repository.append({
        id: 'source-a', personId: 'subject', channel: 'community',
        observedAt: OBSERVED_AT, sourceRecord: { id: 'a' },
      });
      repository.append({
        id: 'source-later', personId: 'subject', channel: 'community',
        observedAt: '2026-08-30T01:00:00.000Z', sourceRecord: { id: 'later' },
      });
    });

    expect(repository.listByPerson('subject').map(({ id }) => id)).toEqual([
      'source-a', 'source-z', 'source-later',
    ]);
  });

  it('requires a write scope, plain-inserts collisions, and has no mutation escape', () => {
    const input = {
      id: 'immutable-source',
      personId: 'subject',
      channel: 'community' as const,
      observedAt: OBSERVED_AT,
      sourceRecord: { event: 'block-party' },
    };
    expect(() => repository.append(input)).toThrow(DomainTransactionRequiredError);
    unitOfWork.immediate(() => repository.append(input));

    expect(() => database.raw.prepare(`
      UPDATE source_events SET channel = 'registry' WHERE id = 'immutable-source'
    `).run()).toThrow();
    expect(() => database.raw.prepare(`
      DELETE FROM source_events WHERE id = 'immutable-source'
    `).run()).toThrow();
    expect(() => database.raw.prepare(`
      INSERT OR REPLACE INTO source_events (
        id, person_id, channel, observed_at, source_record_json, created_at
      ) VALUES ('immutable-source', 'subject', 'registry', ?, '{}', ?)
    `).run(OBSERVED_AT, CREATED_AT)).toThrow();
  });

  it('fails closed when stored source JSON is malformed', () => {
    database.raw.prepare(`
      INSERT INTO source_events (
        id, person_id, channel, observed_at, source_record_json, created_at
      ) VALUES ('malformed', 'subject', 'community', ?, '{bad', ?)
    `).run(OBSERVED_AT, CREATED_AT);

    expect(() => repository.getById('malformed')).toThrow(z.ZodError);
    expect(() => repository.listByPerson('subject')).toThrow(z.ZodError);
  });

  it('fails closed for an unknown stored source-envelope format version', () => {
    database.raw.prepare(`
      INSERT INTO source_events (
        id, person_id, channel, observed_at, source_record_json, created_at
      ) VALUES ('future-format', 'subject', 'community', ?, ?, ?)
    `).run(
      OBSERVED_AT,
      JSON.stringify({
        formatVersion: 2,
        sourceRecord: { event: 'future' },
        customSourceReason: null,
      }),
      CREATED_AT,
    );

    expect(() => repository.getById('future-format')).toThrow(z.ZodError);
  });
});
