import type { SessionQueryable } from '@fss/domain/db';

/**
 * Two workspaces with colliding external identifiers, for the carry tests
 * (specification 6, Appendix G 8).
 *
 * `packages/domain/test/db/support/fixtures.ts` is the canonical one; this is the
 * same discipline inside the worker's own test tree, which does not reach across
 * package boundaries into another package's test directory. It seeds exactly what
 * the carry touches — a workspace, an admin and a salesperson — and nothing else,
 * because a carry creates its own firms.
 *
 * The collision that matters here is the *old firm id*: the same artifact is
 * imported into both workspaces, so every `record_aliases.alias_value` exists twice
 * and the carry's idempotency must be scoped or the second import would find the
 * first workspace's firm.
 */

export interface SeededWorkspace {
  readonly workspaceId: string;
  readonly slug: string;
  readonly adminUserId: string;
  readonly salespersonUserId: string;
}

export interface TwoWorkspaces {
  readonly alpha: SeededWorkspace;
  readonly beta: SeededWorkspace;
  /** The display email both salespeople share; `users.email` is display data. */
  readonly sharedEmail: string;
}

async function seedUser(
  session: SessionQueryable,
  workspaceId: string,
  role: 'admin' | 'salesperson',
  email: string,
  slug: string,
): Promise<string> {
  const user = await session.query<{ id: string }>(
    'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
    [`sub-carry-${slug}-${role}`, email, `${role} ${slug}`],
  );
  const userId = user.rows[0]?.id ?? '';
  await session.query('INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
    workspaceId,
    userId,
    role,
  ]);
  return userId;
}

async function seedWorkspace(session: SessionQueryable, slug: string, sharedEmail: string): Promise<SeededWorkspace> {
  const created = await session.query<{ id: string }>(
    'INSERT INTO workspaces (slug, display_name) VALUES ($1, $2) RETURNING id',
    [slug, `Workspace ${slug}`],
  );
  const workspaceId = created.rows[0]?.id ?? '';
  return {
    workspaceId,
    slug,
    adminUserId: await seedUser(session, workspaceId, 'admin', `admin-${slug}@example.test`, slug),
    salespersonUserId: await seedUser(session, workspaceId, 'salesperson', sharedEmail, slug),
  };
}

export async function seedTwoWorkspaces(session: SessionQueryable): Promise<TwoWorkspaces> {
  const sharedEmail = 'shared.display@example.test';
  return {
    alpha: await seedWorkspace(session, 'carry-alpha', sharedEmail),
    beta: await seedWorkspace(session, 'carry-beta', sharedEmail),
    sharedEmail,
  };
}
