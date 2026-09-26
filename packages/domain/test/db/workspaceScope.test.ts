import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { WorkspaceScopeError, isAdminScope, workspaceId, workspaceScope, type WorkspaceScope } from '../../db/workspaceScope.ts';
import { payloadHash, seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';

/**
 * The workspace scope: the compiler refuses a forged scope (the `@ts-expect-error`
 * below fails `npm run typecheck`, not Vitest), and two workspaces never share rows.
 */

const scope = workspaceScope('11111111-1111-4111-8111-111111111111', {
  kind: 'user',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'admin',
});

/** Never called at runtime; fails `npm run typecheck` the day a forged scope becomes legal. */
function compileTimeProofs(): void {
  // Even with a branded workspace id and a valid actor, the scope brand is missing:
  // `workspaceScope()` is the only way to obtain one.
  // @ts-expect-error a WorkspaceScope cannot be assembled from a plain object literal
  const forged: WorkspaceScope = {
    workspaceId: workspaceId('11111111-1111-4111-8111-111111111111'),
    actor: { kind: 'system', component: 'worker' },
  };
  void forged;
}
void compileTimeProofs;

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

describe('two workspaces with colliding external identifiers', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
  });

  afterAll(async () => {
    await database.drop();
  });

  it('keeps two users who share a display email apart, because the key is the Google sub', async () => {
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM users WHERE email = $1',
      [seeded.sharedEmail],
    );
    expect(Number(rows[0]?.count)).toBe(2);
    expect(seeded.alpha.salesperson.userId).not.toBe(seeded.beta.salesperson.userId);
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
