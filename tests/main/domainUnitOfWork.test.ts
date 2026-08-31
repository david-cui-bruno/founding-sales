import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  AsyncDomainTransactionError,
  DomainTransactionRequiredError,
  NestedDomainTransactionError,
} from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const TIMESTAMP = '2026-08-30T12:00:00.000Z';

describe('DomainUnitOfWork', () => {
  let database: AppDatabase | undefined;
  let tempDatabase: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    tempDatabase?.cleanup();
  });

  async function createUnitOfWork(): Promise<DomainUnitOfWork> {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });
    return new DomainUnitOfWork(database);
  }

  function insertPerson(id: string): void {
    database?.raw.prepare(`
      INSERT INTO persons (
        id, display_name, aliases_json, opted_out, never_record,
        version, created_at, updated_at
      ) VALUES (?, ?, '[]', 0, 0, 1, ?, ?)
    `).run(id, id, TIMESTAMP, TIMESTAMP);
  }

  it('commits every write in one immediate transaction', async () => {
    const unitOfWork = await createUnitOfWork();

    unitOfWork.immediate(() => {
      insertPerson('person-one');
      insertPerson('person-two');
    });

    expect(database?.raw.prepare('SELECT id FROM persons ORDER BY id').all()).toEqual([
      { id: 'person-one' },
      { id: 'person-two' },
    ]);
  });

  it('rolls every write back when the callback throws synchronously', async () => {
    const unitOfWork = await createUnitOfWork();

    expect(() => unitOfWork.immediate(() => {
      insertPerson('rolled-back');
      throw new Error('stop');
    })).toThrow('stop');

    expect(database?.raw.prepare('SELECT count(*) AS count FROM persons').get()).toEqual({
      count: 0,
    });
  });

  it('rolls every write back when SQLite rejects a later statement', async () => {
    const unitOfWork = await createUnitOfWork();

    expect(() => unitOfWork.immediate(() => {
      insertPerson('duplicate');
      insertPerson('duplicate');
    })).toThrow();

    expect(database?.raw.prepare('SELECT count(*) AS count FROM persons').get()).toEqual({
      count: 0,
    });
  });

  it('rejects nested domain transactions and raw active transactions', async () => {
    const unitOfWork = await createUnitOfWork();

    expect(() => unitOfWork.immediate(
      (): undefined => unitOfWork.immediate((): undefined => undefined),
    ))
      .toThrow(NestedDomainTransactionError);

    const rawTransaction = database!.raw.transaction(() => {
      expect(() => unitOfWork.immediate((): undefined => undefined)).toThrow(
        NestedDomainTransactionError,
      );
    });
    rawTransaction.immediate();
  });

  it('rejects runtime thenables and rolls back writes made before they are returned', async () => {
    const unitOfWork = await createUnitOfWork();

    expect(() => unitOfWork.immediate((() => {
      insertPerson('thenable-person');
      return { then: (): undefined => undefined };
    }) as () => never)).toThrow(AsyncDomainTransactionError);

    expect(database?.raw.prepare('SELECT count(*) AS count FROM persons').get()).toEqual({
      count: 0,
    });
  });

  it('prevents an async continuation from writing after its transaction scope is gone', async () => {
    const unitOfWork = await createUnitOfWork();
    const identities = new IdentityRepository({
      database: database!,
      unitOfWork,
      clock: { now: () => TIMESTAMP },
      ids: { next: () => 'escaped-person' },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let continuationError: unknown;

    expect(() => unitOfWork.immediate((() => (async () => {
      await gate;
      try {
        identities.createPerson({ displayName: 'Escaped Person' });
      } catch (error) {
        continuationError = error;
      }
    })()) as () => never)).toThrow(AsyncDomainTransactionError);

    release();
    await gate;
    await Promise.resolve();

    expect(continuationError).toBeInstanceOf(DomainTransactionRequiredError);
    expect(database?.raw.prepare('SELECT count(*) AS count FROM persons').get()).toEqual({
      count: 0,
    });
  });

  it('requires repository mutation to be owned by the active unit of work', async () => {
    const unitOfWork = await createUnitOfWork();
    const identities = new IdentityRepository({
      database: database!,
      unitOfWork,
      clock: { now: () => TIMESTAMP },
      ids: { next: () => 'outside-person' },
    });

    expect(() => identities.createPerson({ displayName: 'Outside' })).toThrow(
      DomainTransactionRequiredError,
    );
  });

  it('rejects a repository wired to a different database before it can autocommit', async () => {
    const unitOfWork = await createUnitOfWork();
    const secondTempDatabase = createTempDatabase();
    const secondKey = createTestWorkspaceKey(0x3b);
    const secondDatabase = openDatabase({ path: secondTempDatabase.path, key: secondKey });
    try {
      await migrateToLatest(secondDatabase, {
        backupDirectory: `${secondTempDatabase.path}.backups`,
        workspaceKey: secondKey,
      });
      let mismatchedRepository: IdentityRepository | undefined;
      let constructionError: unknown;
      try {
        mismatchedRepository = new IdentityRepository({
          database: secondDatabase,
          unitOfWork,
          clock: { now: () => TIMESTAMP },
          ids: { next: () => 'wrong-database-person' },
        });
      } catch (error) {
        constructionError = error;
      }

      if (mismatchedRepository !== undefined) {
        try {
          unitOfWork.immediate(() => {
            mismatchedRepository!.createPerson({ displayName: 'Must Roll Back' });
            throw new Error('rollback');
          });
        } catch {
          // The assertions below prove this path cannot leak an autocommitted row.
        }
      }

      expect(constructionError).toMatchObject({
        name: 'DomainRepositoryDatabaseMismatchError',
      });
      expect(secondDatabase.raw.prepare('SELECT count(*) AS count FROM persons').get())
        .toEqual({ count: 0 });
    } finally {
      closeDatabase(secondDatabase);
      secondTempDatabase.cleanup();
    }
  });

  it('rejects Promise-returning callbacks at compile time', async () => {
    const unitOfWork = await createUnitOfWork();

    const compileOnly = (): void => {
      // @ts-expect-error Domain transactions are intentionally synchronous.
      unitOfWork.immediate(async () => 'not allowed');
      // @ts-expect-error PromiseLike callbacks are intentionally synchronous.
      unitOfWork.immediate((): PromiseLike<string> => ({
        then: (onfulfilled) => Promise.resolve(onfulfilled?.('not allowed')),
      }));
    };

    expect(compileOnly).toEqual(expect.any(Function));
    expect(unitOfWork.immediate(() => 'allowed')).toBe('allowed');
  });
});
