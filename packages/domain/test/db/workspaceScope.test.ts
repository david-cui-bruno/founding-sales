import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import {
  FOUNDATION_LOOKUP_KEYS,
  SCOPED_TABLES,
  matchLookupKey,
  type ScopedTable,
} from '../../db/lookupKeys.ts';
import {
  ScopedQueryError,
  deleteByKey,
  insertOne,
  selectAll,
  selectOne,
} from '../../db/scopedQueries.ts';
import {
  WorkspaceScopeError,
  defineRepository,
  isAdminScope,
  repositoryContext,
  workspaceId,
  workspaceScope,
  type RepositoryContext,
  type WorkspaceScope,
} from '../../db/workspaceScope.ts';
import { payloadHash, seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';

/**
 * The typed workspace scope, proved three ways: the compiler refuses the wrong
 * shapes (the `@ts-expect-error` cases below fail `npm run typecheck`, not Vitest),
 * the registry matches the database's real unique indexes, and two workspaces with
 * colliding external identifiers never see each other's rows.
 */

// --------------------------------------------------------------------------
// Compile-time proof. Each of these is an error the build must keep producing.
// --------------------------------------------------------------------------

const scope = workspaceScope('11111111-1111-4111-8111-111111111111', {
  kind: 'user',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'admin',
});

/**
 * Never called at runtime. Its whole job is to fail `npm run typecheck` the day any
 * of these becomes legal; a `@ts-expect-error` that stops erroring is itself an error.
 */
function compileTimeProofs(anyContext: RepositoryContext): void {
  // A repository function must take the context first.
  defineRepository({
    byCommandId: async (context: RepositoryContext, deviceId: string, commandId: string) =>
      await selectOne(context, 'command_receipts', { device_id: deviceId, command_id: commandId }),
  });

  // @ts-expect-error a repository function that takes a bare id instead of a scope is refused
  defineRepository({ byId: async (id: string) => await Promise.resolve(id) });

  // @ts-expect-error a repository function that takes only a Queryable is refused
  defineRepository({ all: async (db: { query: () => Promise<void> }) => await db.query() });

  // Even with a branded workspace id and a valid actor, the scope brand is missing:
  // `workspaceScope()` is the only way to obtain one.
  // @ts-expect-error a WorkspaceScope cannot be assembled from a plain object literal
  const forged: WorkspaceScope = {
    workspaceId: workspaceId('11111111-1111-4111-8111-111111111111'),
    actor: { kind: 'system', component: 'worker' },
  };
  void forged;

  // @ts-expect-error command_receipts has no bare-id lookup key
  void selectOne(anyContext, 'command_receipts', { id: 'anything' });

  // @ts-expect-error a lookup key may not omit one of the key's columns
  void selectOne(anyContext, 'command_receipts', { device_id: 'a-device' });

  // @ts-expect-error workspace_id comes from the scope and may never be typed by the caller
  void selectOne(anyContext, 'devices', { workspace_id: 'other', id: 'a-device' });

  // @ts-expect-error a table with no declared scoped keys is not a scoped table
  void selectOne(anyContext, 'users', { id: 'someone' });

  // The declared shapes do typecheck.
  void selectOne(anyContext, 'devices', { id: 'a-device' });
  void selectOne(anyContext, 'jobs', { kind: 'mail.sync', idempotency_key: 'mail-sync:1' });
  void selectOne(anyContext, 'calling_identities', { e164: '+14015550123' });
}
void compileTimeProofs;

// --------------------------------------------------------------------------
// Runtime proof.
// --------------------------------------------------------------------------

describe('workspace scope construction', () => {
  it('refuses a workspace id that is not a UUID', () => {
    expect(() => workspaceScope('callie', { kind: 'system', component: 'worker' })).toThrow(WorkspaceScopeError);
  });

  it('lower-cases the workspace id so one workspace has one spelling', () => {
    const upper = workspaceScope('AAAAAAAA-1111-4111-8111-111111111111', { kind: 'system', component: 'worker' });
    expect(upper.workspaceId).toBe('aaaaaaaa-1111-4111-8111-111111111111');
  });

  it('knows an admin scope from a salesperson scope', () => {
    expect(isAdminScope(scope)).toBe(true);
    expect(isAdminScope(workspaceScope(scope.workspaceId, { kind: 'system', component: 'scheduler' }))).toBe(false);
  });
});

describe('the lookup-key registry against the real database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('declares only keys that begin with workspace_id', () => {
    for (const table of SCOPED_TABLES) {
      for (const key of FOUNDATION_LOOKUP_KEYS[table]) {
        expect(key[0]).toBe('workspace_id');
      }
    }
  });

  it('declares only keys the database actually enforces as unique', async () => {
    const { rows } = await database.session.query<{ table_name: string; columns: string }>(`
      SELECT c.relname AS table_name,
             string_agg(a.attname::text, ',' ORDER BY a.attname::text) AS columns
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       WHERE i.indisunique AND n.nspname = 'public' AND i.indpred IS NULL
       GROUP BY c.relname, i.indexrelid
    `);
    expect(rows.length).toBeGreaterThan(10);
    const enforced = new Set(rows.map(row => `${row.table_name}(${row.columns})`));
    for (const table of SCOPED_TABLES) {
      for (const key of FOUNDATION_LOOKUP_KEYS[table]) {
        expect(enforced).toContain(`${table}(${[...key].sort().join(',')})`);
      }
    }
  });

  it('refuses a key the registry does not declare, even when it is assembled at runtime', () => {
    expect(matchLookupKey('command_receipts', ['id'])).toBeNull();
    expect(matchLookupKey('command_receipts', ['device_id', 'command_id'])).toEqual([
      'workspace_id',
      'device_id',
      'command_id',
    ]);
    expect(matchLookupKey('jobs' satisfies ScopedTable, ['kind'])).toBeNull();
  });
});

describe('two workspaces with colliding external identifiers', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let alpha: RepositoryContext;
  let beta: RepositoryContext;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    alpha = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }),
      database.session,
    );
    beta = repositoryContext(
      workspaceScope(seeded.beta.workspaceId, { kind: 'system', component: 'worker' }),
      database.session,
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it('accepts the same command id in both workspaces and keeps each receipt to its own', async () => {
    for (const [context, workspace] of [
      [alpha, seeded.alpha],
      [beta, seeded.beta],
    ] as const) {
      await insertOne(context, 'command_receipts', {
        device_id: workspace.salesperson.deviceId,
        command_id: seeded.collidingCommandId,
        command_kind: 'firm.assign',
        payload_hash: payloadHash(workspace.slug),
        result_status: 'accepted',
      });
    }

    const inAlpha = await selectOne<{ payload_hash: string }, 'command_receipts'>(alpha, 'command_receipts', {
      device_id: seeded.alpha.salesperson.deviceId,
      command_id: seeded.collidingCommandId,
    });
    const inBeta = await selectOne<{ payload_hash: string }, 'command_receipts'>(beta, 'command_receipts', {
      device_id: seeded.beta.salesperson.deviceId,
      command_id: seeded.collidingCommandId,
    });
    expect(inAlpha?.payload_hash).toBe(payloadHash('alpha'));
    expect(inBeta?.payload_hash).toBe(payloadHash('beta'));

    // Beta's scope with alpha's device id finds nothing, even though the row exists.
    const crossed = await selectOne(beta, 'command_receipts', {
      device_id: seeded.alpha.salesperson.deviceId,
      command_id: seeded.collidingCommandId,
    });
    expect(crossed).toBeNull();
  });

  it('accepts the same calling number in both workspaces and never returns the other one', async () => {
    for (const [context, workspace] of [
      [alpha, seeded.alpha],
      [beta, seeded.beta],
    ] as const) {
      await insertOne(context, 'calling_identities', {
        owner_user_id: workspace.salesperson.userId,
        e164: seeded.collidingE164,
        verification_status: 'verified',
        enabled: true,
      });
    }
    const fromAlpha = await selectOne<{ owner_user_id: string }, 'calling_identities'>(alpha, 'calling_identities', {
      e164: seeded.collidingE164,
    });
    const fromBeta = await selectOne<{ owner_user_id: string }, 'calling_identities'>(beta, 'calling_identities', {
      e164: seeded.collidingE164,
    });
    expect(fromAlpha?.owner_user_id).toBe(seeded.alpha.salesperson.userId);
    expect(fromBeta?.owner_user_id).toBe(seeded.beta.salesperson.userId);
  });

  it('accepts the same job kind and idempotency key in both workspaces', async () => {
    for (const context of [alpha, beta]) {
      await insertOne(context, 'jobs', {
        kind: seeded.collidingJobKey.kind,
        payload: JSON.stringify({ mailbox: 'mailbox-1' }),
        idempotency_key: seeded.collidingJobKey.idempotencyKey,
      });
    }
    expect((await selectAll(alpha, 'jobs')).length).toBe(1);
    expect((await selectAll(beta, 'jobs')).length).toBe(1);

    // The second insert in the same workspace is refused: that is the duplicate
    // materialization guard, and it is per workspace rather than global.
    await expect(
      insertOne(alpha, 'jobs', {
        kind: seeded.collidingJobKey.kind,
        payload: JSON.stringify({ mailbox: 'mailbox-1' }),
        idempotency_key: seeded.collidingJobKey.idempotencyKey,
      }),
    ).rejects.toMatchObject({ constraint: 'jobs_idempotent' });
  });

  it('keeps two users who share a display email apart, because the key is the Google sub', async () => {
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM users WHERE email = $1',
      [seeded.sharedEmail],
    );
    expect(Number(rows[0]?.count)).toBe(2);
    expect(seeded.alpha.salesperson.userId).not.toBe(seeded.beta.salesperson.userId);
  });

  it('deletes only inside the scope', async () => {
    expect(
      await deleteByKey(beta, 'command_receipts', {
        device_id: seeded.alpha.salesperson.deviceId,
        command_id: seeded.collidingCommandId,
      }),
    ).toBe(0);
    expect(
      await deleteByKey(alpha, 'command_receipts', {
        device_id: seeded.alpha.salesperson.deviceId,
        command_id: seeded.collidingCommandId,
      }),
    ).toBe(1);
  });

  it('refuses an insert that names workspace_id itself', async () => {
    await expect(
      insertOne(alpha, 'jobs', {
        // workspace_id is the scope's, never the caller's. The column name is a
        // legal string key, so this one is refused at run time rather than by tsc.
        workspace_id: seeded.beta.workspaceId,
        kind: 'today.build',
        payload: JSON.stringify({}),
        idempotency_key: 'today:1',
      }),
    ).rejects.toBeInstanceOf(ScopedQueryError);
  });

  it('refuses a cross-workspace foreign key outright', async () => {
    await expect(
      database.session.query(
        'INSERT INTO devices (workspace_id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4)',
        [seeded.beta.workspaceId, seeded.alpha.salesperson.userId, 'Borrowed Mac', payloadHash('cross')],
      ),
    ).rejects.toMatchObject({ constraint: 'devices_membership_fkey' });
  });
});
