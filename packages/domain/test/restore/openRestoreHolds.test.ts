import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { readSystemGeneration } from '../../db/schemaRange.ts';
import { ALL_BLOCKED_ACTION_KINDS, listApplicableHolds, openHold, releaseHold } from '../../policy/index.ts';
import { advanceSystemGeneration, listOpenHolds, openRestoreHolds } from '../../restore/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * Lane g56: the restore holds of Appendix E step 1 are opened by somebody.
 *
 * Until this lane nothing did, so the drill's step 1 found none in a restored database
 * and stopped (rehearsal run 36062337914, 24 September 2026), and a production restore
 * would have held nothing.
 *
 * ## The vacuous-pass trap, named
 *
 * "A restore hold is in force" passes against a database where one was inserted by the
 * test, which is what every test before this lane did. So the holds here are opened by
 * the function under test and nothing else, as the application role rather than as the
 * owner, and each case is asserted through the read every gate makes
 * (`listApplicableHolds` for a dial subject), not only by counting rows. The other half
 * is selectivity: an unrelated hold is opened first in each workspace and must come out
 * of every case, including step 9, exactly as it went in.
 */

const MIGRATION_SCOPE = { kind: 'system', component: 'migration' } as const;

let database: TestDatabase;
let workspaces: TwoWorkspaces;
let runtime: SessionQueryable;
let unrelated: Record<'alpha' | 'beta', string>;

async function restoreHoldRows(): Promise<
  readonly { workspace_id: string; scope_kind: string; scope_key: string | null; blocked_action_kinds: string[]; source_event_kind: string; source_event_id: string | null; recovery_action: string | null }[]
> {
  const { rows } = await database.session.query<{
    workspace_id: string;
    scope_kind: string;
    scope_key: string | null;
    blocked_action_kinds: string[];
    source_event_kind: string;
    source_event_id: string | null;
    recovery_action: string | null;
  }>(
    `SELECT workspace_id, scope_kind, scope_key, blocked_action_kinds, source_event_kind, source_event_id, recovery_action
       FROM active_holds
      WHERE reason_code = 'restore_in_progress' AND released_at IS NULL
      ORDER BY workspace_id`,
  );
  return rows;
}

async function unrelatedStillOpen(): Promise<number> {
  const { rows } = await database.session.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM active_holds WHERE id = ANY ($1::uuid[]) AND released_at IS NULL',
    [[unrelated.alpha, unrelated.beta]],
  );
  return Number(rows[0]?.count ?? '0');
}

beforeAll(async () => {
  database = await createTestDatabase();
  workspaces = await seedTwoWorkspaces(database.session);
  runtime = await database.appRuntimeSession();
  // One hold that is not a restore hold in each workspace, so "touches nothing else" is
  // a claim about two real rows rather than about an empty table.
  const alpha = repositoryContext(workspaceScope(workspaces.alpha.workspaceId, MIGRATION_SCOPE), database.session);
  const beta = repositoryContext(workspaceScope(workspaces.beta.workspaceId, MIGRATION_SCOPE), database.session);
  unrelated = {
    alpha: await openHold(alpha, {
      scopeKind: 'owner',
      scopeKey: workspaces.alpha.salesperson.userId,
      reasonCode: 'mailbox_disconnected',
      blockedActionKinds: ['email_send'],
      sourceEventKind: 'mailbox.disconnected',
    }),
    beta: await openHold(beta, {
      scopeKind: 'workspace',
      reasonCode: 'scoped_pause',
      blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
      sourceEventKind: 'admin.pause',
    }),
  };
});

afterAll(async () => {
  await database.drop();
});

describe('openRestoreHolds', () => {
  it('opens nothing, and reads nothing, when the generation is the expected one', async () => {
    const outcome = await withTransaction(runtime, async () =>
      openRestoreHolds(runtime, { observedGeneration: 1, expectedGeneration: 1, openedBy: 'worker' }),
    );
    expect(outcome).toEqual({ mismatch: false, opened: [], alreadyHeld: 0 });
    expect(await restoreHoldRows()).toHaveLength(0);
  });

  it('opens one workspace-scope restore hold per workspace, as the application role, and a dial is then refused', async () => {
    const observed = await readSystemGeneration(runtime);
    expect(observed).toBe(1);
    const outcome = await withTransaction(runtime, async () =>
      openRestoreHolds(runtime, { observedGeneration: 1, expectedGeneration: 2, openedBy: 'worker' }),
    );
    expect(outcome.mismatch).toBe(true);
    expect(outcome.alreadyHeld).toBe(0);
    expect(outcome.opened.map(entry => entry.workspaceId).sort()).toEqual(
      [workspaces.alpha.workspaceId, workspaces.beta.workspaceId].sort(),
    );

    const rows = await restoreHoldRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.scope_kind).toBe('workspace');
      expect(row.scope_key).toBeNull();
      expect([...row.blocked_action_kinds].sort()).toEqual([...ALL_BLOCKED_ACTION_KINDS].sort());
      expect(row.source_event_kind).toBe('restore.generation_mismatch');
      expect(row.source_event_id).toBe('worker:1->2');
      expect(row.recovery_action).toBe('advance_generation');
    }

    // The read the dial and send gates make, for a subject that names nothing but the
    // action: a workspace-scope hold is the only kind that answers it.
    for (const workspace of [workspaces.alpha, workspaces.beta]) {
      const context = repositoryContext(
        workspaceScope(workspace.workspaceId, { kind: 'user', userId: workspace.salesperson.userId, role: 'salesperson' }),
        runtime,
      );
      for (const actionKind of ['dial_authorization', 'email_send', 'enrollment_advance'] as const) {
        const holds = await listApplicableHolds(context, { actionKind, ownerUserId: workspace.salesperson.userId });
        expect(holds.map(hold => hold.reasonCode), `${workspace.slug} ${actionKind}`).toContain('restore_in_progress');
      }
    }
    expect(await unrelatedStillOpen()).toBe(2);
  });

  it('is idempotent: a second run while the holds are in force opens nothing new', async () => {
    const outcome = await withTransaction(runtime, async () =>
      openRestoreHolds(runtime, { observedGeneration: 1, expectedGeneration: 2, openedBy: 'fss' }),
    );
    expect(outcome).toEqual({ mismatch: true, opened: [], alreadyHeld: 2 });
    expect(await restoreHoldRows()).toHaveLength(2);
    expect(await unrelatedStillOpen()).toBe(2);
  });

  it('opens nothing twice when two openers start together, because the lock makes the check and the insert one step', async () => {
    // Clear the two from the case above by id, so the race starts from nothing held.
    for (const hold of await listOpenHolds(database.session, { reason: 'restore_in_progress' })) {
      await releaseHold(repositoryContext(workspaceScope(hold.workspaceId, MIGRATION_SCOPE), database.session), hold.id);
    }
    expect(await restoreHoldRows()).toHaveLength(0);

    const first = await database.appRuntimeSession();
    const second = await database.appRuntimeSession();
    const [a, b] = await Promise.all(
      [first, second].map(async session =>
        withTransaction(session, async () =>
          openRestoreHolds(session, { observedGeneration: 1, expectedGeneration: 2, openedBy: 'worker' }),
        ),
      ),
    );
    expect((a?.opened.length ?? 0) + (b?.opened.length ?? 0)).toBe(2);
    expect((a?.alreadyHeld ?? 0) + (b?.alreadyHeld ?? 0)).toBe(2);
    expect(await restoreHoldRows()).toHaveLength(2);
    // A released restore hold is history, not a hold in force: it did not stop these.
    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM active_holds WHERE reason_code = 'restore_in_progress' AND released_at IS NOT NULL",
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('is released by step 9 and nothing else is, and the pin then matches the database', async () => {
    const outcome = await withTransaction(database.session, async () =>
      advanceSystemGeneration(database.session, {
        adminUserId: workspaces.alpha.admin.userId,
        notes: 'g56 step 9',
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.value.generation).toBe(2);
    expect(outcome.value.releasedRestoreHolds).toBe(2);
    expect(await restoreHoldRows()).toHaveLength(0);
    // 4.3: "Clearing one hold never clears another."
    expect(await unrelatedStillOpen()).toBe(2);

    // The pin that opened the holds (2) is the generation step 9 produced, so the next
    // start with that pin opens nothing: the steady state after a restore.
    const after = await withTransaction(runtime, async () =>
      openRestoreHolds(runtime, {
        observedGeneration: (await readSystemGeneration(runtime)) ?? 0,
        expectedGeneration: 2,
        openedBy: 'worker',
      }),
    );
    expect(after).toEqual({ mismatch: false, opened: [], alreadyHeld: 0 });
    expect(await restoreHoldRows()).toHaveLength(0);
  });
});
